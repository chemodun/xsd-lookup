import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DOMParser } from '@xmldom/xmldom';


interface ElementMapEntry {
  parent: string | null;
  node: Element;
}

interface ElementWithParent {
  name: string;
  parent: string | null;
  node: Element;
}

interface SchemaIndex {
  elements: Record<string, Element[]>;
  types: Record<string, Element>;
  groups: Record<string, Element>;
  attributeGroups: Record<string, Element>;
  elementContexts: Record<string, ElementContext[]>; // Track group membership
}

interface HierarchyCache {
  attributeCache: WeakMap<Element, AttributeInfo[]>;
  enhancedAttributesCache: WeakMap<Element, EnhancedAttributeInfo[]>;
  elementDefinitionCache: Map<string, Element | undefined>; // New cache for getElementDefinition
  // Performance caches (not size-limited via ensureCacheSize):
  elementsInDefinitionCache: WeakMap<Element, Element[]>; // cache of findAllElementsInDefinition
  elementsInDefinitionByNameCache: WeakMap<Element, Map<string, Element[]>>; // cache of findElementsInDefinition
  contentModelCache?: WeakMap<Element, Element | null>; // cache of findContentModel
  annotationCache?: WeakMap<Element, string>; // cache of extractAnnotationText/type fallback
  possibleChildrenResultCache: WeakMap<Element, Map<string, Map<string, string>>>; // cache final results per key (Record for low overhead)
  // New caches for performance
  validChildCache?: WeakMap<Element, Map<string, Map<string, boolean>>>; // parentDef -> prevKey -> childName -> boolean
  modelNextNamesCache?: WeakMap<Element, Map<string, Set<string>>>; // contentModel -> prevKey -> allowed names
  modelStartNamesCache?: WeakMap<Element, Set<string>>; // contentModel -> start names
  containsCache: WeakMap<Element, WeakMap<Element, boolean>>; // item Element -> elementName -> contains?
  validationsCache: WeakMap<Element, Partial<EnhancedAttributeInfo>>; // element -> validationName -> isValid
}

type CacheCounter = { hits: number; misses: number; sets: number };
type CacheStats = {
  attributeCache: CacheCounter;
  enhancedAttributesCache: CacheCounter;
  elementDefinitionCache: CacheCounter;
  elementsInDefinitionByNameCache: CacheCounter;
  elementsInDefinitionCache: CacheCounter;
  contentModelCache: CacheCounter;
  annotationCache: CacheCounter;
  possibleChildrenResultCache: CacheCounter;
  validChildCache: CacheCounter;
  modelStartNamesCache: CacheCounter;
  modelNextNamesCache: CacheCounter;
  containsCache: CacheCounter;
  validationsCache: CacheCounter;
};

export interface ElementLocation {
  uri: string;
  line: number;
  column: number;
  lengthOfStartTag: number;
}

export interface AttributeInfo {
  name: string;
  node: Element;
}

export interface EnhancedAttributeInfo {
  name: string;
  type?: string;
  location?: ElementLocation;
  required?: boolean;
  enumValues?: string[];
  enumValuesAnnotations?: Map<string, string>; // Map of enum value to its annotation text
  annotation?: string; // Attribute's own annotation text
  patterns?: string[]; // Changed to support multiple patterns
  minLength?: number;
  maxLength?: number;
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
}

export interface AttributeValidationResult {
  isValid: boolean;
  expectedType?: string;
  allowedValues?: string[];
  errorMessage?: string;
  restrictions?: string[];
}

interface ElementContext {
  element: Element;
  groups: string[];  // Groups this element belongs to
  parents: string[]; // Parent element types this can appear in
}

export class Schema {
  private doc: Document;
  private name: string = '';
  private schemaIndex: SchemaIndex;
  private elementMap: Record<string, ElementMapEntry[]>;
  private cache!: HierarchyCache;
  private cacheStats!: CacheStats;
  private methodTimings: Record<string, number> = {};
  private methodCalls: Record<string, number> = {};
  private maxCacheSize: number = 100000;
  private shouldProfileCaches: boolean = false;
  private shouldProfileMethods: boolean = false;

  private static readonly numericTypes = new Set<string>([
    'xs:int', 'xs:integer', 'xs:long', 'xs:short', 'xs:byte',
    'xs:float', 'xs:double', 'xs:decimal',
    'xs:positiveInteger', 'xs:negativeInteger', 'xs:nonPositiveInteger', 'xs:nonNegativeInteger',
    'xs:unsignedInt', 'xs:unsignedLong', 'xs:unsignedShort', 'xs:unsignedByte'
  ]);

  private static readonly builtInTypes = new Set<string>([
    'string', 'int', 'integer', 'decimal', 'boolean', 'date', 'time', 'dateTime',
    'duration', 'float', 'double', 'anyURI', 'QName', 'NOTATION'
  ]);

  constructor(xsdFilePath: string, includeFiles: string[] = []) {
    // Initialize caches and metrics first
    this.initializeCaches();
    this.initializeCacheStats();
    this.shouldProfileCaches = ((process.env.XSDL_PROFILE_CACHES || '').trim() === '1');
    this.shouldProfileMethods = ((process.env.XSDL_PROFILE_METHODS || '').trim() === '1');
    this.name = path.basename(xsdFilePath);
    this.doc = this.loadXml(xsdFilePath);

    // Merge include files if any
    for (const includeFile of includeFiles) {
      const includeDoc = this.loadXml(includeFile);
      this.mergeXsds(this.doc, includeDoc);
    }

    // Build indexes
    this.schemaIndex = this.indexSchema(this.doc.documentElement as any);
    this.elementMap = this.buildElementMap();
  }

  /**
   * Initialize all cache structures with empty maps
   */
  private initializeCaches(): void {
    this.cache = {
      attributeCache: new WeakMap<Element, AttributeInfo[]>(),
      enhancedAttributesCache: new WeakMap<Element, EnhancedAttributeInfo[]>(),
      elementDefinitionCache: new Map(),
      elementsInDefinitionCache: new WeakMap<Element, Element[]>(),
      elementsInDefinitionByNameCache: new WeakMap<Element, Map<string, Element[]>>(),
      contentModelCache: new WeakMap<Element, Element | null>(),
      annotationCache: new WeakMap<Element, string>(),
      possibleChildrenResultCache: new WeakMap<Element, Map<string, Map<string, string>>>(),
      validChildCache: new WeakMap<Element, Map<string, Map<string, boolean>>>(),
      modelNextNamesCache: new WeakMap<Element, Map<string, Set<string>>>(),
      modelStartNamesCache: new WeakMap<Element, Set<string>>(),
      containsCache: new WeakMap<Element, WeakMap<Element, boolean>>(),
      validationsCache: new WeakMap<Element, Partial<EnhancedAttributeInfo>>()
    };
  }

  private initializeCacheStats(): void {
    const zero = (): CacheCounter => ({ hits: 0, misses: 0, sets: 0 });
    this.cacheStats = {
      attributeCache: zero(),
      enhancedAttributesCache: zero(),
      elementDefinitionCache: zero(),
      elementsInDefinitionByNameCache: zero(),
      elementsInDefinitionCache: zero(),
      contentModelCache: zero(),
      annotationCache: zero(),
      possibleChildrenResultCache: zero(),
      validChildCache: zero(),
      modelStartNamesCache: zero(),
      modelNextNamesCache: zero(),
      containsCache: zero(),
      validationsCache: zero(),
    };
  }

  private printCacheStats(): void {
    if (!this.shouldProfileCaches) return;
    const entries = Object.keys(this.cacheStats) as (keyof CacheStats)[];
    const rows = entries
      .map((name) => {
        const c = this.cacheStats[name];
        return { name: String(name), hits: c.hits, misses: c.misses, sets: c.sets };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const headers = ['Name', 'Hits', 'Misses', 'Sets'];
    const col1W = Math.max(headers[0].length, ...rows.map(r => r.name.length));
    const col2W = Math.max(headers[1].length, ...rows.map(r => String(r.hits).length));
    const col3W = Math.max(headers[2].length, ...rows.map(r => String(r.misses).length));
    const col4W = Math.max(headers[3].length, ...rows.map(r => String(r.sets).length));
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    const lines: string[] = [];
    lines.push(`=== XSD-Lookup Cache Stats for "${this.name}" ===`);
    lines.push(
      pad(headers[0], col1W) + '  ' +
      pad(headers[1], col2W) + '  ' +
      pad(headers[2], col3W) + '  ' +
      pad(headers[3], col4W)
    );
    lines.push(
      '-'.repeat(col1W) + '  ' +
      '-'.repeat(col2W) + '  ' +
      '-'.repeat(col3W) + '  ' +
      '-'.repeat(col4W)
    );
    for (const r of rows) {
      lines.push(
        pad(r.name, col1W) + '  ' +
        pad(String(r.hits), col2W) + '  ' +
        pad(String(r.misses), col3W) + '  ' +
        pad(String(r.sets), col4W)
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }

  // Method timing profiling
  private profStart(): number { return (globalThis.performance?.now?.() ?? Date.now()); }
  private profEnd(method: string, t0: number): void {
    if (!this.shouldProfileMethods) return;
    const t1 = (globalThis.performance?.now?.() ?? Date.now());
    const dt = t1 - t0;
    this.methodTimings[method] = (this.methodTimings[method] || 0) + dt;
    this.methodCalls[method] = (this.methodCalls[method] || 0) + 1;
  }
  private printMethodStats(): void {
    if (!this.shouldProfileMethods) return;
    const rows = Object.entries(this.methodTimings)
      .map(([name, total]) => {
        const calls = this.methodCalls[name] || 0;
        const avg = calls > 0 ? total / calls : 0;
        return { name, total, calls, avg };
      })
      .sort((a, b) => b.total - a.total);

    if (rows.length === 0) return;

    const headers = ['Name', 'Total Time (ms)', 'Count Calls', 'Average Time (ms)'];
    const col1W = Math.max(headers[0].length, ...rows.map(r => r.name.length));
    const col2W = Math.max(headers[1].length, ...rows.map(r => r.total.toFixed(3).length));
    const col3W = Math.max(headers[2].length, ...rows.map(r => String(r.calls).length));
    const col4W = Math.max(headers[3].length, ...rows.map(r => r.avg.toFixed(3).length));
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    const lines: string[] = [];
    lines.push(`=== XSD-Lookup Method Profile for "${this.name}" ===`);
    lines.push(
      pad(headers[0], col1W) + '  ' +
      pad(headers[1], col2W) + '  ' +
      pad(headers[2], col3W) + '  ' +
      pad(headers[3], col4W)
    );
    lines.push(
      '-'.repeat(col1W) + '  ' +
      '-'.repeat(col2W) + '  ' +
      '-'.repeat(col3W) + '  ' +
      '-'.repeat(col4W)
    );
    for (const r of rows) {
      lines.push(
        pad(r.name, col1W) + '  ' +
        pad(r.total.toFixed(3), col2W) + '  ' +
        pad(String(r.calls), col3W) + '  ' +
        pad(r.avg.toFixed(3), col4W)
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }

  /**
   * Clear all caches by reinitializing them
   */
  public clearCache(): void {
    this.initializeCaches();
  }

  /**
   * Ensure cache sizes don't exceed the maximum limit using simple LRU eviction
   */
  private ensureCacheSize(): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (this.cache.elementDefinitionCache.size > this.maxCacheSize) {
        const entries = Array.from(this.cache.elementDefinitionCache.entries());
        const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
        this.cache.elementDefinitionCache.clear();
        toKeep.forEach(([key, value]) => this.cache.elementDefinitionCache.set(key, value));
      }
    } finally {
      if (__profiling) {
        this.profEnd('ensureCacheSize', __t0);
      }
    }
  }


  /**
   * Load and parse an XML file into a DOM Document
   * @param filePath The path to the XML file to load
   * @returns Parsed DOM Document
   */
  private loadXml(filePath: string): Document {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const xml = fs.readFileSync(filePath, 'utf8');
      const doc = new DOMParser().parseFromString(xml, 'application/xml') as any;
      // Pre-split file into lines for faster per-line operations
      const lines = xml.split(/\r\n|\r|\n/);
      const linesCount = lines.length;
      // Annotate all elements in this document with their source file path so callers can resolve origin
      try {
        const annotate = (node: Node) => {
          if (!node) return;
          if (node.nodeType === 1) {
            const el = node as Element;
            // Store as a non-XSD attribute to avoid interfering with schema semantics
            if (!el.getAttribute('data-source-file')) {
              el.setAttribute('data-source-file', filePath);
            }
            const anyEl = el as any;
            const line: number | undefined = anyEl.lineNumber ?? anyEl.line;
            const column: number | undefined = anyEl.columnNumber ?? anyEl.column;
            if (typeof line === 'number' && typeof column === 'number' && line >= 1 && line <= linesCount && column >= 1 && !el.getAttribute('start-tag-length')) {
              const lineStr = lines[line - 1];
              if (column <= lineStr.length && lineStr[column - 1] === '<') {
                const closingTagIdx = lineStr.indexOf('>', column - 1);
                const length = closingTagIdx >= 0 ? closingTagIdx - (column - 1) + 1 : lineStr.length - (column - 1);
                if (typeof closingTagIdx === 'number') {
                  el.setAttribute('start-tag-length', String(length));
                }
              }
            }
          }
          // Recurse children
          // eslint-disable-next-line @typescript-eslint/prefer-for-of
          for (let i = 0; i < (node.childNodes ? node.childNodes.length : 0); i++) {
            annotate(node.childNodes[i]);
          }
        };
        if (doc && doc.documentElement) annotate(doc.documentElement);
      } catch {
        // Best-effort; if annotation fails, we still return the parsed document
      }
      return doc;
    } finally {
      if (__profiling) {
        this.profEnd('loadXml', __t0);
      }
    }
  }

  /**
   * Merge included XSD documents into the main schema document
   * @param mainDoc The main schema document to merge into
   * @param includeDoc The included schema document to merge from
   */
  private mergeXsds(mainDoc: Document, includeDoc: Document): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const mainSchema = mainDoc.documentElement;
      const includeSchema = includeDoc.documentElement;
      for (let i = 0; i < includeSchema.childNodes.length; i++) {
        const node = includeSchema.childNodes[i];
        if (node.nodeType === 1) {
          mainSchema.appendChild(node.cloneNode(true));
        }
      }

    } finally {
      if (__profiling) {
        this.profEnd('mergeXsds', __t0);
      }
    }
  }
  /**
   * Recursively collect all element definitions from the schema DOM
   * @param node The current node to examine
   * @param parentName The name of the parent element
   * @param elements Array to collect found elements into
   * @returns Array of collected elements with their parent information
   */
  private collectElements(node: Node, parentName: string | null, elements: ElementWithParent[] = []): ElementWithParent[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!node) return elements;
      if (node.nodeType === 1) {
        const element = node as Element;
        if (element.localName === 'element' && element.hasAttribute('name')) {
          elements.push({
            name: element.getAttribute('name')!,
            parent: parentName,
            node: element
          });
        }
        // Recurse into children
        for (let i = 0; i < element.childNodes.length; i++) {
          this.collectElements(element.childNodes[i], element.getAttribute('name') || parentName, elements);
        }
      }
      return elements;

    } finally {
      if (__profiling) {
        this.profEnd('collectElements', __t0);
      }
    }
  }
  /**
   * Build a map of element names to their definitions and parent relationships
   * @returns Record mapping element names to arrays of their definitions
   */
  private buildElementMap(): Record<string, ElementMapEntry[]> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const elements = this.collectElements(this.doc.documentElement, null);
      const elementMap: Record<string, ElementMapEntry[]> = {};
      elements.forEach(e => {
        if (!elementMap[e.name]) elementMap[e.name] = [];
        elementMap[e.name].push({ parent: e.parent, node: e.node });
      });
      return elementMap;
    } finally {
      if (__profiling) {
        this.profEnd('buildElementMap', __t0);
      }
    }
  }
  /**
   * Index the schema by collecting all global elements, groups, attribute groups, and types
   * @param root The root schema element
   * @param ns The XML Schema namespace prefix
   * @returns Complete schema index with all definitions and contexts
   */
  private indexSchema(root: Element): SchemaIndex {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const elements: Record<string, Element[]> = {};  // Changed to arrays
      const groups: Record<string, Element> = {};
      const attributeGroups: Record<string, Element> = {};
      const types: Record<string, Element> = {};

      // First, collect only direct children of the schema root (truly global elements)
      for (let i = 0; i < root.childNodes.length; i++) {
        const child = root.childNodes[i];
        if (child.nodeType === 1) {
          const element = child as Element;
          const elementName = element.getAttribute('name');
          if (elementName) {
            if (element.localName === 'element') {
              if (!elements[elementName]) elements[elementName] = [];
              elements[elementName].push(element);
            }
            else if (element.localName === 'group') {
              groups[elementName] = element;
            }
            else if (element.localName === 'attributeGroup') {
              attributeGroups[elementName] = element;
            }
            else if (element.localName === 'complexType') {
              types[elementName] = element;
            }
            else if (element.localName === 'simpleType') {
              types[elementName] = element;
            }
          }
        }
      }

      // Then walk recursively to collect all types, groups, and attribute groups (which can be nested)
      const walkForTypesAndGroups = (node: Node): void => {
        if (!node || node.nodeType !== 1) return;
        const element = node as Element;
        const elementName = element.getAttribute('name');

        // Only collect types and groups, not nested elements
        if (elementName) {
          if (element.localName === 'group') {
            groups[elementName] = element;
          }
          if (element.localName === 'attributeGroup') {
            attributeGroups[elementName] = element;
          }
          if (element.localName === 'complexType' && elementName) {
            types[elementName] = element;
          }
          if (element.localName === 'simpleType' && elementName) {
            types[elementName] = element;
          }
        }

        // Recurse into children
        for (let i = 0; i < element.childNodes.length; i++) {
          walkForTypesAndGroups(element.childNodes[i]);
        }
      };

      walkForTypesAndGroups(root);

      // Build comprehensive element contexts including group membership
      const elementContexts = this.buildElementContexts(elements, groups, types);

      return { elements, groups, attributeGroups, types, elementContexts };
    } finally {
      if (__profiling) this.profEnd('indexSchema', __t0);
    }
  }

  /**
   * Build comprehensive element contexts, including elements reachable through groups
   */
  private buildElementContexts(
    globalElements: Record<string, Element[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>
  ): Record<string, ElementContext[]> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const elementContexts: Record<string, ElementContext[]> = {};

      // First, add all global elements as their own contexts
      for (const [elementName, elements] of Object.entries(globalElements)) {
        if (!elementContexts[elementName]) elementContexts[elementName] = [];

        for (const element of elements) {
          elementContexts[elementName].push({
            element,
            groups: [], // Global elements don't belong to groups directly
            parents: [] // Will be filled in later when we analyze where they can appear
          });
        }
      }

      // Then, traverse all groups to find elements defined within them
      for (const [groupName, groupElement] of Object.entries(groups)) {
        this.extractElementsFromGroup(groupElement, groupName, elementContexts, groups, types);
      }

      // IMPORTANT: Also traverse all global elements to find inline element definitions
      // This captures cases like param under params, where param is defined inline
      // AND handles type references in context (e.g., library element using interrupt_library type)
      for (const [elementName, elements] of Object.entries(globalElements)) {
        for (const element of elements) {
          this.extractInlineElementsFromElement(element, elementContexts, groups, types, [elementName]);
        }
      }

      return elementContexts;
    } finally {
      if (__profiling) {
        this.profEnd('buildElementContexts', __t0);
      }
    }
  }

  /**
   * Extract all elements from a group and add them to element contexts
   */
  private extractElementsFromGroup(
    groupElement: Element,
    groupName: string,
    elementContexts: Record<string, ElementContext[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>,
    visitedGroups: Set<string> = new Set()
  ): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Prevent infinite recursion in group references
      if (visitedGroups.has(groupName)) return;
      visitedGroups.add(groupName);

      const extractElements = (node: Element, currentGroups: string[]): void => {
        if (!node || node.nodeType !== 1) return;

        // If this is an element definition, add it to contexts
        if (node.localName === 'element' && node.getAttribute('name')) {
          const elementName = node.getAttribute('name')!;

          if (!elementContexts[elementName]) elementContexts[elementName] = [];

          // Check if we already have this exact element in this group context
          const existingContext = elementContexts[elementName].find(ctx =>
            ctx.element === node &&
            JSON.stringify(ctx.groups.sort()) === JSON.stringify(currentGroups.sort())
          );

          if (!existingContext) {
            elementContexts[elementName].push({
              element: node,
              groups: [...currentGroups],
              parents: [] // Will be filled in later
            });
          }
        }

        // If this is a group reference, recursively extract from the referenced group
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refGroupName = node.getAttribute('ref')!;
          const refGroup = groups[refGroupName];
          if (refGroup && !visitedGroups.has(refGroupName)) {
            this.extractElementsFromGroup(refGroup, refGroupName, elementContexts, groups, types, new Set(visitedGroups));
          }
        }

        // Handle type extensions - extract elements from the base type
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = types[baseName];
          if (baseType) {
            // Extract elements from the base type within the current element's context
            // For group elements, we need to find the parent element
            let parentElement = node.parentNode;
            while (parentElement && parentElement.nodeType === 1) {
              const parentElem = parentElement as Element;
              if (parentElem.localName === 'element') {
                const parentElementName = parentElem.getAttribute('name');
                if (parentElementName) {
                  // Extract elements from the base type with the parent element as context
                  this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, new Set(), [parentElementName]);
                }
                break;
              }
              parentElement = parentElement.parentNode;
            }
          }
        }

        // Recursively process all children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractElements(child as Element, currentGroups);
          }
        }
      };

      // Start extraction with the current group in the context
      extractElements(groupElement, [groupName]);
    } finally {
      if (__profiling) {
        this.profEnd('extractElementsFromGroup', __t0);
      }
    }
  }

  /**
   * Extract elements from a group while maintaining parent context information
   */
  private extractElementsFromGroupWithParentContext(
    groupElement: Element,
    groupName: string,
    elementContexts: Record<string, ElementContext[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>,
    parentContext: string[],
    visitedGroups: Set<string> = new Set()
  ): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Prevent infinite recursion
      if (visitedGroups.has(groupName)) return;
      visitedGroups.add(groupName);

      const extractElements = (node: Element): void => {
        if (!node || node.nodeType !== 1) return;

        // If this is an element definition, add it to contexts with group and parent info
        if (node.localName === 'element' && node.getAttribute('name')) {
          const elementName = node.getAttribute('name')!;

          if (!elementContexts[elementName]) elementContexts[elementName] = [];

          // Add context with both group membership and parent information
          elementContexts[elementName].push({
            element: node,
            groups: [groupName],
            parents: [...parentContext] // Use the passed parent context
          });
        }

        // If this is a group reference, recursively extract
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refGroupName = node.getAttribute('ref')!;
          const refGroup = groups[refGroupName];
          if (refGroup && !visitedGroups.has(refGroupName)) {
            this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, parentContext, new Set(visitedGroups));
          }
        }

        // Handle type extensions - extract elements from the base type
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = types[baseName];
          if (baseType) {
            // Extract elements from the base type within the current element's context
            // For group elements with parent context, we need to find the parent element
            let parentElement = node.parentNode;
            while (parentElement && parentElement.nodeType === 1) {
              const parentElem = parentElement as Element;
              if (parentElem.localName === 'element') {
                const parentElementName = parentElem.getAttribute('name');
                if (parentElementName) {
                  // Extract elements from the base type with the parent element as context
                  this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, new Set(), [parentElementName, ...parentContext]);
                }
                break;
              }
              parentElement = parentElement.parentNode;
            }
          }
        }

        // Recursively process all children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractElements(child as Element);
          }
        }
      };

      extractElements(groupElement);
    } finally {
      if (__profiling) {
        this.profEnd('extractElementsFromGroupWithParentContext', __t0);
      }
    }
  }

  /**
   * Extract all elements from a complex type and add them to element contexts
   */
  private extractElementsFromType(
    typeElement: Element,
    typeName: string,
    elementContexts: Record<string, ElementContext[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>,
    visitedTypes: Set<string> = new Set(),
    parentElementNames: string[] = []
  ): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Prevent infinite recursion in type references
      if (visitedTypes.has(typeName)) return;
      visitedTypes.add(typeName);

      // Use the provided parent element names instead of the type name
      const currentParents = parentElementNames.length > 0 ? parentElementNames : [typeName];

      const extractElements = (node: Element, currentParents: string[]): void => {
        if (!node || node.nodeType !== 1) return;

        // If this is an element definition, add it to contexts
        if (node.localName === 'element' && node.getAttribute('name')) {
          const elementName = node.getAttribute('name')!;

          if (!elementContexts[elementName]) elementContexts[elementName] = [];

          // Check if we already have this exact element in this parent context
          const existingContext = elementContexts[elementName].find(ctx =>
            ctx.element === node &&
            JSON.stringify(ctx.parents.sort()) === JSON.stringify(currentParents.sort())
          );

          if (!existingContext) {
            elementContexts[elementName].push({
              element: node,
              groups: [], // Will be filled if this element is found through group references
              parents: [...currentParents]
            });

            // Check if this element also has a type reference - if so, extract elements from that type
            const typeAttr = node.getAttribute('type');
            if (typeAttr && types[typeAttr] && !visitedTypes.has(typeAttr)) {
              // Extract elements from the referenced type with this element as parent
              this.extractElementsFromType(types[typeAttr], typeAttr, elementContexts, groups, types, new Set(), [elementName, ...currentParents]);
            }
          }
        }

        // If this is a group reference, extract elements from the group and mark with group membership
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refGroupName = node.getAttribute('ref')!;
          const refGroup = groups[refGroupName];
          if (refGroup) {
            // Extract elements from the group and mark them with group membership
            // Only pass the immediate parent, not the full chain
            const immediateParent = currentParents.length > 0 ? [currentParents[0]] : [];
            this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, immediateParent);
          }
        }

        // Handle type extensions - extract elements from the base type
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = types[baseName];
          if (baseType && !visitedTypes.has(baseName)) {
            // Extract elements from the base type with the same parent context
            this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, new Set([...visitedTypes, baseName]), currentParents);
          }
        }

        // Recursively process all children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractElements(child as Element, currentParents);
          }
        }
      };

      // Start extraction with the current parent element names
      extractElements(typeElement, currentParents);
    } finally {
      if (__profiling) {
        this.profEnd('extractElementsFromType', __t0);
      }
    }
  }

  /**
   * Extract inline elements from a global element definition
   * This captures elements like param under params that are defined inline
   */
  private extractInlineElementsFromElement(
    parentElement: Element,
    elementContexts: Record<string, ElementContext[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>,
    initialParents: string[] = []
  ): void {

    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const extractInlineElements = (node: Element, currentParents: string[], isRootElement: boolean = false): void => {
        if (!node || node.nodeType !== 1) return;

        // If this is an inline element definition, add it to contexts
        if (node.localName === 'element' && node.getAttribute('name')) {
          const elementName = node.getAttribute('name')!;

          if (!elementContexts[elementName]) elementContexts[elementName] = [];

          // Only add to contexts if this is not the root element we started with
          if (!isRootElement) {
            // Add this inline element with its parent context
            elementContexts[elementName].push({
              element: node,
              groups: [], // Inline elements don't belong to groups directly
              parents: [...currentParents]
            });
          }

          // IMPORTANT: When we find an element, it becomes a potential parent for nested elements
          // Continue recursion with this element added to the parent chain
          // BUT: Don't add the root element to its own parent chain
          const newParents = isRootElement ? currentParents : [elementName, ...currentParents];

          // Check if this element has a type reference - if so, extract elements from that type
          const typeAttr = node.getAttribute('type');
          if (typeAttr && types[typeAttr]) {
            // Extract elements from the referenced type with this element as parent
            this.extractElementsFromType(types[typeAttr], typeAttr, elementContexts, groups, types, new Set(), [elementName]);
          }

          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType === 1) {
              extractInlineElements(child as Element, newParents, false);
            }
          }
          return; // Don't process children again with the old parent chain
        }

        // If this is a group reference, extract elements from the group
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refGroupName = node.getAttribute('ref')!;
          const refGroup = groups[refGroupName];
          if (refGroup) {
            this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, currentParents);
          }
        }

        // Handle type extensions - extract elements from the base type
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = types[baseName];
          if (baseType) {
            // Extract elements from the base type with the same parent context
            this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, new Set(), currentParents);
          }
        }

        // Recursively process all children with the same parent context
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractInlineElements(child as Element, currentParents, false);
          }
        }
      };

      // Start extraction with the initial parents as context, marking the root element
      extractInlineElements(parentElement, initialParents, true);
    } finally {
      if (__profiling) {
        this.profEnd('extractInlineElements', __t0);
      }
    }
  }

  public getElementDefinition(elementName: string, hierarchy: string[] = []): Element | undefined {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Create cache key from element name and hierarchy
      const hierarchyKey = hierarchy.length > 0 ? hierarchy.join('|') : '';
      const fullCacheKey = `${elementName}::${hierarchyKey}`;

      // Check if we have an exact match in cache
      if (this.cache.elementDefinitionCache.has(fullCacheKey)) {
        if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.hits++;
        const cached = this.cache.elementDefinitionCache.get(fullCacheKey);
        if (cached) this.enrichElementAnnotationFromTypeIfMissing(cached);
        return cached;
      }
      if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.misses++;
      const elementsFromMap = this.elementMap[elementName];
      if (elementsFromMap && elementsFromMap.length === 1) {
        const elementFromMap = elementsFromMap[0].node;
        this.cache.elementDefinitionCache.set(fullCacheKey, elementFromMap);
        if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.sets++;
        this.ensureCacheSize();
        this.enrichElementAnnotationFromTypeIfMissing(elementFromMap);
        return elementFromMap;
      }

      // Check for partial matches in cache - look for any cached key that starts with our element name
      // and has a hierarchy that our current hierarchy extends
      if (hierarchy.length > 0) {
        let keyPrefix = '';
        for (const segment of hierarchy) {
          keyPrefix += `|${segment}`;
          const fullKey = `${elementName}::${keyPrefix}`;
          const cachedElement = this.cache.elementDefinitionCache.get(fullKey);
          if (cachedElement) {
            if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.hits++;
            this.cache.elementDefinitionCache.set(fullCacheKey, cachedElement);
            if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.sets++;
            this.ensureCacheSize();
            this.enrichElementAnnotationFromTypeIfMissing(cachedElement);
            return cachedElement;
          }
        }
      }

      // No cache hit, perform the actual search

      let result: Element | undefined;

      // Step 1: If no hierarchy provided, only return global elements
      if (hierarchy.length === 0) {
        // Look for global elements (direct children of schema root)
        const globalElements = this.getGlobalElementDefinitions(elementName);
        result = globalElements.length > 0 ? globalElements[0] : undefined;
      } else {
        // Step 2: INCREMENTAL HIERARCHY APPROACH
        // hierarchy = [immediate_parent, grandparent, great_grandparent, ...]
        // Try each level incrementally: bottom-up expansion, then top-down search

        for (let level = 1; level <= hierarchy.length; level++) {
          // Take the first 'level' elements from hierarchy (bottom-up expansion)
          const currentHierarchy = hierarchy.slice(0, level);

          // Reverse for top-down search: [great_grandparent, ..., grandparent, immediate_parent]
          const topDownHierarchy = [...currentHierarchy].reverse();

          // Try to find element with this hierarchy level using top-down search
          const foundElement = this.findElementTopDown(elementName, topDownHierarchy);

          if (foundElement) {
            // Found a definition at this level
            result = foundElement;

            // Cache this intermediate result too (it might be useful for future lookups)
            const intermediateCacheKey = `${elementName}::${currentHierarchy.join('|')}`;
            this.cache.elementDefinitionCache.set(intermediateCacheKey, result);
            if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.sets++;

            break; // Exit the loop since we found a match
          }
        }
      }

      // If found, enrich with annotation structure from referenced type when missing
      if (result) {
        this.enrichElementAnnotationFromTypeIfMissing(result);
      }

      // Cache the final result (even if undefined)
      this.cache.elementDefinitionCache.set(fullCacheKey, result);
      if (this.shouldProfileCaches) this.cacheStats.elementDefinitionCache.sets++;
      this.ensureCacheSize();

      return result;
    } finally {
      if (__profiling) this.profEnd('getElementDefinition', __t0);
    }
  }

  // Clone xs:annotation/xs:documentation from the referenced type onto the element
  // if the element lacks its own annotation with text. No hardcoding: fully data-driven by XSD.
  private enrichElementAnnotationFromTypeIfMissing(elementDef: Element): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!elementDef || elementDef.nodeType !== 1) return;
      if (elementDef.localName !== 'element') return;

      // Already enriched or already has an annotation node
      if ((elementDef as Element).getAttribute('data-annotation-enriched') === '1') return;
      for (let i = 0; i < elementDef.childNodes.length; i++) {
        const c = elementDef.childNodes[i];
        if (c.nodeType === 1 && (c as Element).localName === 'annotation') {
          // Has its own annotation structure already
          // Additionally ensure it has text; if empty, we still respect existing structure and don't override
          return;
        }
      }

      const typeName = elementDef.getAttribute('type');
      if (!typeName) return;
      const unprefixed = typeName.replace(/^.*:/, '');
      const typeDef = this.schemaIndex.types[typeName] || this.schemaIndex.types[unprefixed];
      if (!typeDef) return;

      // Ensure the type actually contains documentation text
      const typeDocText = Schema.extractAnnotationText(typeDef);
      if (!typeDocText || typeDocText.trim() === '') return;

      // Find an annotation element to clone (prefer direct child)
      const typeAnnotationEl = this.findFirstAnnotationElement(typeDef);
      if (!typeAnnotationEl) return;

      const cloned = typeAnnotationEl.cloneNode(true);
      try {
        elementDef.appendChild(cloned);
        (elementDef as Element).setAttribute('data-annotation-enriched', '1');
        // Sync annotation cache so getAnnotationCached returns the new text immediately
        if (this.cache && this.cache.annotationCache) {
          this.cache.annotationCache.set(elementDef, typeDocText);
        }
      } catch {
        // Ignore DOM append errors silently; non-critical enhancement
      }
    } finally {
      if (__profiling) {
        this.profEnd('enrichElementAnnotationFromTypeIfMissing', __t0);
      }
    }
  }

  // Locate the first xs:annotation element in the given node (direct child preferred, otherwise bounded DFS)
  private findFirstAnnotationElement(node: Element): Element | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Prefer direct child annotation
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 1 && (c as Element).localName === 'annotation') {
          // Ensure documentation with some text exists inside
          const hasDocText = this.annotationElementHasText(c as Element);
          if (hasDocText) return c as Element;
        }
      }
      // Bounded DFS to avoid heavy scans
      const stack: { el: Element; depth: number }[] = [];
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 1) stack.push({ el: c as Element, depth: 1 });
      }
      const maxDepth = 4;
      while (stack.length) {
        const { el, depth } = stack.pop()!;
        if (el.localName === 'annotation' && this.annotationElementHasText(el)) {
          return el;
        }
        if (depth >= maxDepth) continue;
        for (let i = 0; i < el.childNodes.length; i++) {
          const c = el.childNodes[i];
          if (c.nodeType === 1) stack.push({ el: c as Element, depth: depth + 1 });
        }
      }
      return null;
    } finally {
      if (__profiling) {
        this.profEnd('findFirstAnnotationElement', __t0);
      }
    }
  }

  // Check if an xs:annotation element contains xs:documentation with non-empty text
  private annotationElementHasText(annotationEl: Element): boolean {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      for (let i = 0; i < annotationEl.childNodes.length; i++) {
        const child = annotationEl.childNodes[i];
        if (child.nodeType === 1 && (child as Element).localName === 'documentation') {
          const docEl = child as Element;
          const text = (docEl.textContent || '').trim();
          if (text.length > 0) return true;
        }
      }
      return false;
    } finally {
      if (__profiling) {
        this.profEnd('annotationElementHasText', __t0);
      }
    }
  }

  /**
   * Get global element definitions by name (direct children of schema root only)
   * @param elementName The name of the element to find
   * @returns Array of global element definitions
   */
  private getGlobalElementDefinitions(elementName: string): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Only return truly global elements (direct children of schema root)
      if (this.schemaIndex.elements[elementName]) {
        return this.schemaIndex.elements[elementName];
      }

      // Do NOT fall back to elementMap as it contains nested elements too
      return [];

    } finally {
      if (__profiling) {
        this.profEnd('getGlobalElementDefinitions', __t0);
      }
    }
  }

  /**
   * Get global element or type definitions by name for hierarchical search
   * @param name The name to search for
   * @returns Array of element or type definitions matching the name
   */
  private getGlobalElementOrTypeDefs(name: string): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const defs: Element[] = [];
      const seenNodes = new Set<Element>();

      // Check global elements
      if (this.schemaIndex.elements[name]) {
        for (const element of this.schemaIndex.elements[name]) {
          if (!seenNodes.has(element)) {
            defs.push(element);
            seenNodes.add(element);
          }
        }
      }

      // Check global types
      if (this.schemaIndex.types[name]) {
        const typeElement = this.schemaIndex.types[name];
        if (!seenNodes.has(typeElement)) {
          defs.push(typeElement);
          seenNodes.add(typeElement);
        }
      }

      // For hierarchical search, we also need to include elements from elementMap
      // but ONLY when this method is called from hierarchical search context
      // The elementMap contains elements that may be reachable through hierarchy
      const mapDefs = this.elementMap[name] || [];
      for (const mapDef of mapDefs) {
        if (!seenNodes.has(mapDef.node)) {
          defs.push(mapDef.node);
          seenNodes.add(mapDef.node);
        }
      }

      return defs;
    } finally {
      if (__profiling) {
        this.profEnd('getGlobalElementOrTypeDefs', __t0);
      }
    }
  }

  /**
   * Find element definitions within a parent definition by element name
   * @param parentDef The parent element or type definition to search in
   * @param elementName The name of the element to find
   * @returns Array of matching element definitions
   */
  private findElementsInDefinition(parentDef: Element, elementName: string): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!parentDef) return [];

      const cache = this.cache.elementsInDefinitionByNameCache;
      let cached: Map<string, Element[]>;
      if (cache.has(parentDef)) {
        cached = cache.get(parentDef)!;
        if (cached && cached.has(elementName)) {
          if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionByNameCache.hits++;
          return cached.get(elementName)!;
        }
      } else {
        cached = new Map();
        cache.set(parentDef, cached);
      }
      if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionByNameCache.misses++;

      const results: Element[] = [];
      let maxSearchDepth = 0;

      // Get the actual type definition to search in
      let typeNode = parentDef;

      // If parentDef is an element, get its type
      if (parentDef.localName === 'element') {
        const typeName = parentDef.getAttribute('type');
        if (typeName && this.schemaIndex.types[typeName]) {
          typeNode = this.schemaIndex.types[typeName];
        } else {
          // Look for inline complexType
          for (let i = 0; i < parentDef.childNodes.length; i++) {
            const child = parentDef.childNodes[i];
            if (child.nodeType === 1 && (child as Element).localName === 'complexType') {
              typeNode = child as Element;
              break;
            }
          }
        }
      }

      // Search recursively through the type definition with optimizations
      const visited = new Set<Element>();

      const searchInNode = (node: Element, depth: number = 0): void => {
        if (!node || node.nodeType !== 1) return;

        // Track maximum search depth for metrics
        maxSearchDepth = Math.max(maxSearchDepth, depth);

        // Depth limit for performance - prevent excessive recursion
        if (depth > 20) return;

        // Use the actual DOM node reference for cycle detection to avoid false positives
        // This ensures we only skip when we encounter the exact same node again
        if (visited.has(node)) return;
        visited.add(node);

        // Check if this is the element we're looking for
        if (node.localName === 'element' && node.getAttribute('name') === elementName) {
          results.push(node);
          return; // Don't recurse into found elements - early exit optimization
        }

        // Early exit optimization: if we've found enough results, stop searching
        if (results.length >= 3) return;

        // Handle type references and extensions
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = this.schemaIndex.types[baseName];
          if (baseType) {
            searchInNode(baseType, depth + 1);
          }
        }

        // Handle group references
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refName = node.getAttribute('ref')!;
          const groupDef = this.schemaIndex.groups[refName];
          if (groupDef) {
            searchInNode(groupDef, depth + 1);
          }
        }

        // Handle structural elements - recurse into ALL children
        if (node.localName === 'sequence' ||
          node.localName === 'choice' ||
          node.localName === 'all' ||
          node.localName === 'complexType' ||
          node.localName === 'complexContent' ||
          node.localName === 'simpleContent' ||
          node.localName === 'group') {

          // For structural nodes, recursively search all children
          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType === 1) {
              searchInNode(child as Element, depth + 1);
              // Early exit if we found enough results
              if (results.length >= 3) break;
            }
          }
        }
      };

      searchInNode(typeNode);

      if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionByNameCache.sets++;
      cached.set(elementName, results);
      return results;
    } finally {
      if (__profiling) {
        this.profEnd('findElementsInDefinition', __t0);
      }
    }
  }

  /**
   * Find ALL immediate child elements within a parent definition (without filtering by name)
   * This is similar to findElementsInDefinition but returns all direct child elements
   * @param parentDef The parent element or type definition to search in
   * @returns Array of all immediate child element definitions
   */
  private findAllElementsInDefinition(parentDef: Element): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!parentDef) return [];

      const cache = this.cache.elementsInDefinitionCache;
      const cached = cache.get(parentDef);
      if (cached) {
        if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionCache.hits++;
        return cached;
      }
      if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionCache.misses++;

      const results: Element[] = [];

      // Get the actual type definition to search in
      let typeNode = parentDef;

      // If parentDef is an element, get its type
      if (parentDef.localName === 'element') {
        const typeName = parentDef.getAttribute('type');
        if (typeName && this.schemaIndex.types[typeName]) {
          typeNode = this.schemaIndex.types[typeName];
        } else {
          // Look for inline complexType
          for (let i = 0; i < parentDef.childNodes.length; i++) {
            const child = parentDef.childNodes[i];
            if (child.nodeType === 1 && (child as Element).localName === 'complexType') {
              typeNode = child as Element;
              break;
            }
          }
        }
      }

      // Search for IMMEDIATE child elements (limited depth for performance)
      const visited = new Set<Element>();

      const searchInNode = (node: Element): void => {
        if (!node || node.nodeType !== 1) return;

        // Use the actual DOM node reference for cycle detection
        if (visited.has(node)) return;
        visited.add(node);

        // If this is an element definition, add it to results
        if (node.localName === 'element' && node.getAttribute('name')) {
          results.push(node);
          return; // Don't recurse into found elements - we only want immediate children
        }

        // Handle type references and extensions
        if (node.localName === 'extension' && node.getAttribute('base')) {
          const baseName = node.getAttribute('base')!;
          const baseType = this.schemaIndex.types[baseName];
          if (baseType) {
            searchInNode(baseType);
          }
        }

        // Handle group references
        if (node.localName === 'group' && node.getAttribute('ref')) {
          const refName = node.getAttribute('ref')!;
          const groupDef = this.schemaIndex.groups[refName];
          if (groupDef) {
            searchInNode(groupDef);
          }
        }

        // Handle structural elements - recurse into ALL children
        if (node.localName === 'sequence' ||
          node.localName === 'choice' ||
          node.localName === 'all' ||
          node.localName === 'complexType' ||
          node.localName === 'complexContent' ||
          node.localName === 'simpleContent' ||
          node.localName === 'group') {

          // For structural nodes, recursively search all children
          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType === 1) {
              searchInNode(child as Element);
            }
          }
        }
      };

      searchInNode(typeNode);

      cache.set(parentDef, results);
      if (this.shouldProfileCaches) this.cacheStats.elementsInDefinitionCache.sets++;

      return results;

    } finally {
      if (__profiling) {
        this.profEnd('findAllElementsInDefinition', __t0);
      }
    }
  }

  /**
   * Get enhanced attribute information including type and validation details
   */
  public getElementAttributes(elementName: string, hierarchy: string[] = [], element?: Element): AttributeInfo[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const attributes: Record<string, Element> = {};

      if (!element) {
        // Get the correct element definition based on hierarchical context
        element = this.getElementDefinition(elementName, hierarchy);
        if (!element) {
          // Cache empty result
          return [];
        }
      }

      const cache = this.cache.attributeCache;
      if (cache.has(element)) {
        if (this.shouldProfileCaches) this.cacheStats.attributeCache.hits++;
        return cache.get(element)!;
      }
      if (this.shouldProfileCaches) this.cacheStats.attributeCache.misses++;

      // Collect attributes from the element definition
      this.collectAttrs(element, attributes);

      const result = Object.entries(attributes).map(([name, node]) => ({ name, node }));

      cache.set(element, result);
      if (this.shouldProfileCaches) this.cacheStats.attributeCache.sets++;

      return result;
    } finally {
      if (__profiling) this.profEnd('getElementAttributes', __t0);
    }
  }

  /**
   * Recursively collect attributes from element and type definitions
   * @param node The current node to collect attributes from
   * @param attributes Record to accumulate found attributes
   * @param visited Set to track visited nodes and prevent infinite recursion
   */
  private collectAttrs(node: Element, attributes: Record<string, Element>, visited: Set<string> = new Set()): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!node || node.nodeType !== 1) return;

      // Use a unique key for types/groups to avoid infinite recursion
      let key: string | null = null;
      if (node.localName === 'complexType' && node.getAttribute('name')) {
        key = 'type:' + node.getAttribute('name');
      } else if (node.localName === 'group' && node.getAttribute('name')) {
        key = 'group:' + node.getAttribute('name');
      } else if (node.localName === 'attributeGroup' && node.getAttribute('name')) {
        key = 'attrgroup:' + node.getAttribute('name');
      } else if (node.localName === 'attributeGroup' && node.getAttribute('ref')) {
        key = 'attrgroupref:' + node.getAttribute('ref');
      }

      if (key && visited.has(key)) return;
      if (key) visited.add(key);

      // Handle different node types
      if (node.localName === 'attribute') {
        const name = node.getAttribute('name');
        if (name) {
          attributes[name] = node;
        }
      } else if (node.localName === 'attributeGroup' && node.getAttribute('ref')) {
        // Attribute group reference - resolve the reference
        const refName = node.getAttribute('ref')!;
        const group = this.schemaIndex.attributeGroups[refName];
        if (group) {
          this.collectAttrs(group, attributes, visited);
        }
      } else if (node.localName === 'attributeGroup' && node.getAttribute('name')) {
        // Named attribute group definition - process its children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            this.collectAttrs(child as Element, attributes, visited);
          }
        }
      } else if (node.localName === 'extension' && node.getAttribute('base')) {
        // Type extension - inherit from base and add own attributes
        const baseName = node.getAttribute('base')!;
        const base = this.schemaIndex.types[baseName];
        if (base) {
          this.collectAttrs(base, attributes, visited);
        }
        // Also process the extension's own attributes and attribute groups
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            this.collectAttrs(child as Element, attributes, visited);
          }
        }
      } else if (node.localName === 'complexContent' ||
        node.localName === 'simpleContent') {
        // Content wrapper - process children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            this.collectAttrs(child as Element, attributes, visited);
          }
        }
      } else if (node.localName === 'complexType' ||
        node.localName === 'sequence' ||
        node.localName === 'choice' ||
        node.localName === 'all') {
        // Structural nodes - traverse children but skip nested element definitions
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1 && (child as Element).localName !== 'element') {
            this.collectAttrs(child as Element, attributes, visited);
          }
        }
      }

      // Handle type reference
      const typeName = node.getAttribute('type');
      if (typeName && this.schemaIndex.types[typeName]) {
        this.collectAttrs(this.schemaIndex.types[typeName], attributes, visited);
      }

      // Handle inline complexType
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1 && (child as Element).localName === 'complexType') {
          this.collectAttrs(child as Element, attributes, visited);
          break;
        }
      }
    } finally {
      if (__profiling) {
        this.profEnd('collectAttrs', __t0);
      }
    }
  }
  /**
   * Get enhanced attribute information including type and validation details
   */
  public getElementAttributesWithTypes(elementName: string, hierarchy: string[] = []): EnhancedAttributeInfo[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {

      const element = this.getElementDefinition(elementName, hierarchy);
      if (!element) return [];

      const cache = this.cache.enhancedAttributesCache;
      if (cache.has(element)) {
        if (this.shouldProfileCaches) this.cacheStats.enhancedAttributesCache.hits++;
        return cache.get(element)!;
      }
      if (this.shouldProfileCaches) this.cacheStats.enhancedAttributesCache.misses++;

      const attributes = this.getElementAttributes(elementName, hierarchy, element);

      // Enhance each attribute with type information
      const enhancedAttributes = attributes.map(attr => {
        const enhancedAttr: EnhancedAttributeInfo = {
          name: attr.name,
          type: attr.node.getAttribute('type') || undefined,
          required: attr.node.getAttribute('use') === 'required'
        };

        // Get element location information
        enhancedAttr.location = Schema.getElementLocation(attr.node);

        // Extract attribute's own annotation
        const annotation = Schema.extractAnnotationText(attr.node);
        if (annotation) {
          enhancedAttr.annotation = annotation;
        }

        // If the attribute has a type reference, get comprehensive validation information
        if (enhancedAttr.type) {
          const typeValidation = this.getTypeValidationInfo(enhancedAttr.type);
          Object.assign(enhancedAttr, typeValidation);
        } else {
          // Check for inline type definition (xs:simpleType)
          const inlineTypeValidation = this.getInlineTypeValidationInfo(attr.node);
          Object.assign(enhancedAttr, inlineTypeValidation);

          // If we found inline enumeration values, set the type to indicate it's an enumeration
          if (inlineTypeValidation.enumValues && inlineTypeValidation.enumValues.length > 0) {
            enhancedAttr.type = 'enumeration';
          }
        }

        return enhancedAttr;
      });
      cache.set(element, enhancedAttributes);
      if (this.shouldProfileCaches) this.cacheStats.enhancedAttributesCache.sets++;
      return enhancedAttributes;
    } finally {
      if (__profiling) this.profEnd('getElementAttributesWithTypes', __t0);
    }
  }

  /**
   * Get comprehensive validation information for a type
   */
  private getTypeValidationInfo(typeName: string): Partial<EnhancedAttributeInfo> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const typeNode = this.schemaIndex.types[typeName];
      if (!typeNode) return {};

      const cache = this.cache.validationsCache;
      if (cache.has(typeNode)) {
        if (this.shouldProfileCaches) this.cacheStats.validationsCache.hits++;
        return cache.get(typeNode)!;
      }
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.misses++;
      const validationInfo: Partial<EnhancedAttributeInfo> = {};
      const extractValidationRules = (node: Element): void => {
        if (!node || node.nodeType !== 1) return;

        // Use the reusable validation rule extraction
        this.extractValidationRulesFromNode(node, validationInfo);

        // Handle inheritance: if this is a restriction with a base type, inherit from base
        if (node.localName === 'restriction') {
          const baseType = node.getAttribute('base');
          if (baseType && baseType !== 'xs:string' && baseType.indexOf(':') === -1) {
            // This is a user-defined base type, not a built-in XSD type
            const baseInfo = this.getTypeValidationInfo(baseType);
            // Merge base info into current info (current restrictions take precedence)
            Object.assign(validationInfo, baseInfo, validationInfo);
          }
        }

        // Handle union types: collect validation info from all member types
        if (node.localName === 'union') {
          const memberTypes = node.getAttribute('memberTypes');
          if (memberTypes) {
            // Split memberTypes by whitespace to get individual type names
            const typeNames = memberTypes.trim().split(/\s+/);
            for (const memberTypeName of typeNames) {
              if (memberTypeName) {
                // Recursively get validation info for each member type
                const memberInfo = this.getTypeValidationInfo(memberTypeName);

                // Merge patterns (union means ANY pattern can match)
                if (memberInfo.patterns) {
                  if (!validationInfo.patterns) validationInfo.patterns = [];
                  validationInfo.patterns.push(...memberInfo.patterns);
                }

                // Merge enumerations (union means ANY enum value is valid)
                if (memberInfo.enumValues) {
                  if (!validationInfo.enumValues) validationInfo.enumValues = [];
                  validationInfo.enumValues.push(...memberInfo.enumValues);
                }

                // For numeric restrictions, use the most permissive ranges
                if (memberInfo.minInclusive !== undefined) {
                  validationInfo.minInclusive = validationInfo.minInclusive !== undefined
                    ? Math.min(validationInfo.minInclusive, memberInfo.minInclusive)
                    : memberInfo.minInclusive;
                }

                if (memberInfo.maxInclusive !== undefined) {
                  validationInfo.maxInclusive = validationInfo.maxInclusive !== undefined
                    ? Math.max(validationInfo.maxInclusive, memberInfo.maxInclusive)
                    : memberInfo.maxInclusive;
                }

                if (memberInfo.minExclusive !== undefined) {
                  validationInfo.minExclusive = validationInfo.minExclusive !== undefined
                    ? Math.min(validationInfo.minExclusive, memberInfo.minExclusive)
                    : memberInfo.minExclusive;
                }

                if (memberInfo.maxExclusive !== undefined) {
                  validationInfo.maxExclusive = validationInfo.maxExclusive !== undefined
                    ? Math.max(validationInfo.maxExclusive, memberInfo.maxExclusive)
                    : memberInfo.maxExclusive;
                }

                // For length restrictions, use the most permissive ranges
                if (memberInfo.minLength !== undefined) {
                  validationInfo.minLength = validationInfo.minLength !== undefined
                    ? Math.min(validationInfo.minLength, memberInfo.minLength)
                    : memberInfo.minLength;
                }

                if (memberInfo.maxLength !== undefined) {
                  validationInfo.maxLength = validationInfo.maxLength !== undefined
                    ? Math.max(validationInfo.maxLength, memberInfo.maxLength)
                    : memberInfo.maxLength;
                }
              }
            }
          }
        }

        // Recursively search child nodes (but skip the base validation rules since we use extractValidationRulesFromNode now)
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractValidationRules(child as Element);
          }
        }
      };

      extractValidationRules(typeNode);

      // Extract enum value annotations if we have enumeration values
      if (validationInfo.enumValues && validationInfo.enumValues.length > 0) {
        validationInfo.enumValuesAnnotations = this.extractEnumValueAnnotations(typeNode);
      }
      cache.set(typeNode, validationInfo);
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.sets++;
      return validationInfo;
    } finally {
      if (__profiling) this.profEnd('getTypeValidationInfo', __t0);
    }
  }

  /**
   * Get validation information from inline type definitions (xs:simpleType within attribute)
   */
  private getInlineTypeValidationInfo(attributeNode: Element): Partial<EnhancedAttributeInfo> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const cache = this.cache.validationsCache;
      if (cache.has(attributeNode)) {
        if (this.shouldProfileCaches) this.cacheStats.validationsCache.hits++;
        return cache.get(attributeNode)!;
      }
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.misses++;

      const validationInfo: Partial<EnhancedAttributeInfo> = {};
      // Look for inline xs:simpleType definition within the attribute node
      for (let i = 0; i < attributeNode.childNodes.length; i++) {
        const child = attributeNode.childNodes[i];
        if (child.nodeType === 1 && (child as Element).localName === 'simpleType') {
          const simpleTypeNode = child as Element;

          // Extract validation rules from the inline simpleType
          this.extractValidationRulesFromNode(simpleTypeNode, validationInfo);

          // Extract enum value annotations if we have enumeration values
          if (validationInfo.enumValues && validationInfo.enumValues.length > 0) {
            validationInfo.enumValuesAnnotations = this.extractEnumValueAnnotations(simpleTypeNode);
          }

          break; // Found the simpleType, no need to continue
        }
      }

      cache.set(attributeNode, validationInfo);
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.sets++;
      return validationInfo;
    } finally {
      if (__profiling) this.profEnd('getInlineTypeValidationInfo', __t0);
    }
  }

  /**
   * Get cached validation information for a node
   */
  private getCachedValidationInfo(node: Element): Partial<EnhancedAttributeInfo> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const cache = this.cache.validationsCache;
      if (cache.has(node)) {
        if (this.shouldProfileCaches) this.cacheStats.validationsCache.hits++;
        return cache.get(node)!;
      }
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.misses++;
      const validationInfo: Partial<EnhancedAttributeInfo> = {};
      this.extractValidationRulesFromNode(node, validationInfo);
      cache.set(node, validationInfo);
      if (this.shouldProfileCaches) this.cacheStats.validationsCache.sets++;
      return validationInfo;
    } finally {
      if (__profiling) this.profEnd('getCachedValidationInfo', __t0);
    }
  }

  /**
   * Extract validation rules from a node (reusable logic)
   */
  private extractValidationRulesFromNode(node: Element, validationInfo: Partial<EnhancedAttributeInfo>): void {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (!node || node.nodeType !== 1) return;

      // Extract enumeration values
      if (node.localName === 'enumeration') {
        const value = node.getAttribute('value');
        if (value) {
          if (!validationInfo.enumValues) validationInfo.enumValues = [];
          validationInfo.enumValues.push(value);
        }
      }

      // Extract pattern restrictions
      if (node.localName === 'pattern') {
        const pattern = node.getAttribute('value');
        if (pattern) {
          if (!validationInfo.patterns) validationInfo.patterns = [];
          validationInfo.patterns.push(pattern);
        }
      }

      // Extract length restrictions
      if (node.localName === 'minLength') {
        const minLength = parseInt(node.getAttribute('value') || '0', 10);
        if (!isNaN(minLength)) {
          validationInfo.minLength = minLength;
        }
      }

      if (node.localName === 'maxLength') {
        const maxLength = parseInt(node.getAttribute('value') || '0', 10);
        if (!isNaN(maxLength)) {
          validationInfo.maxLength = maxLength;
        }
      }

      // Extract numeric range restrictions
      if (node.localName === 'minInclusive') {
        const minInclusive = parseFloat(node.getAttribute('value') || '0');
        if (!isNaN(minInclusive)) {
          validationInfo.minInclusive = minInclusive;
        }
      }

      if (node.localName === 'maxInclusive') {
        const maxInclusive = parseFloat(node.getAttribute('value') || '0');
        if (!isNaN(maxInclusive)) {
          validationInfo.maxInclusive = maxInclusive;
        }
      }

      if (node.localName === 'minExclusive') {
        const minExclusive = parseFloat(node.getAttribute('value') || '0');
        if (!isNaN(minExclusive)) {
          validationInfo.minExclusive = minExclusive;
        }
      }

      if (node.localName === 'maxExclusive') {
        const maxExclusive = parseFloat(node.getAttribute('value') || '0');
        if (!isNaN(maxExclusive)) {
          validationInfo.maxExclusive = maxExclusive;
        }
      }

      // Recursively search child nodes for validation rules (but not inheritance/union logic)
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          this.extractValidationRulesFromNode(child as Element, validationInfo);
        }
      }
    } finally {
      if (__profiling) this.profEnd('extractValidationRulesFromNode', __t0);
    }
  }

  /**
   * Validate an attribute value against its XSD definition
   */
  public validateAttributeValue(elementName: string, attributeName: string, attributeValue: string, hierarchy: string[] = []): AttributeValidationResult {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const attributes = this.getElementAttributesWithTypes(elementName, hierarchy);
      const attrInfo = attributes.find(attr => attr.name === attributeName);

      if (!attrInfo) {
        return {
          isValid: false,
          errorMessage: `Attribute '${attributeName}' not found for element '${elementName}'`
        };
      }

      // If no type specified, it's valid (any string)
      if (!attrInfo.type) {
        return { isValid: true };
      }

      // Comprehensive validation using all available restrictions
      return this.validateValueWithRestrictions(attributeValue, attrInfo);
    } finally {
      if (__profiling) this.profEnd('validateAttributeValue', __t0);
    }
  }

  /**
   * Normalize multi-line attribute values for validation
   * Joins multiple lines into a single line, removing newlines and extra spaces
   */
  private normalizeAttributeValue(value: string): string {
    // Replace all types of line breaks with spaces
    let normalized = value.replace(/\r\n|\r|\n/g, ' ');

    // Replace multiple consecutive spaces with single spaces
    normalized = normalized.replace(/\s+/g, ' ');

    // Trim leading and trailing whitespace
    normalized = normalized.trim();

    return normalized;
  }

  /**
   * Validate a value against all possible XSD restrictions
   */
  private validateValueWithRestrictions(value: string, attrInfo: EnhancedAttributeInfo): AttributeValidationResult {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Normalize the value for validation (join multi-line content)
      const normalizedValue = this.normalizeAttributeValue(value);

      const restrictions: string[] = [];

      // For union types, we need to check if the value matches ANY of the validation rules
      // Priority: enumerations first (more specific), then patterns (more general)

      // 1. Check enumeration validation first (highest priority for union types)
      if (attrInfo.enumValues && attrInfo.enumValues.length > 0) {
        const enumValidationPassed = attrInfo.enumValues.includes(normalizedValue);
        if (enumValidationPassed) {
          // If enum validation passes, we're done - enums take precedence
          return {
            isValid: true,
            expectedType: attrInfo.type,
            allowedValues: attrInfo.enumValues
          };
        }
        // Enum validation failed, but continue to check patterns for union types
        // If there are no patterns, this will fail at the end with enum-only error
      }    // 2. If enum validation failed or no enums present, check pattern validation
      if (attrInfo.patterns && attrInfo.patterns.length > 0) {
        const validPatterns: string[] = [];

        for (const pattern of attrInfo.patterns) {
          try {
            // Anchor the pattern to match the entire string (if not already anchored)
            let fullPattern = pattern;
            if (!pattern.startsWith('^')) {
              fullPattern = '^' + pattern;
            }
            if (!pattern.endsWith('$')) {
              fullPattern = fullPattern + '$';
            }

            const regex = new RegExp(fullPattern);
            validPatterns.push(pattern);
            if (regex.test(normalizedValue)) {
              // Pattern validation passed - this is valid for union types
              return {
                isValid: true,
                expectedType: attrInfo.type,
                restrictions: validPatterns.map(p => `Pattern: ${p}`)
              };
            }
          } catch (e) {
            // Invalid regex pattern in XSD - skip this pattern
            restrictions.push(`Pattern validation skipped (invalid regex: ${pattern})`);
          }
        }

        // If we reach here, neither enums nor patterns matched
        if (attrInfo.enumValues && attrInfo.enumValues.length > 0) {
          // We have both enums and patterns, but neither matched
          const displayValue = value === normalizedValue ? value : `${value} (normalized: ${normalizedValue})`;
          return {
            isValid: false,
            expectedType: attrInfo.type,
            allowedValues: attrInfo.enumValues,
            restrictions: validPatterns.map(p => `Pattern: ${p}`),
            errorMessage: `Value '${displayValue}' does not match any allowed enumerations or patterns. Expected one of: ${attrInfo.enumValues.join(', ')} OR a value matching patterns: ${validPatterns.join(' OR ')}`
          };
        } else {
          // Only patterns available, but none matched
          const displayValue = value === normalizedValue ? value : `${value} (normalized: ${normalizedValue})`;
          return {
            isValid: false,
            expectedType: attrInfo.type,
            restrictions: validPatterns.map(p => `Pattern: ${p}`),
            errorMessage: `Value '${displayValue}' does not match any of the required patterns: ${validPatterns.join(' OR ')}`
          };
        }
      }

      // 3. If we have enums but no patterns, and enum validation failed, return error
      if (attrInfo.enumValues && attrInfo.enumValues.length > 0 &&
        (!attrInfo.patterns || attrInfo.patterns.length === 0)) {
        const displayValue = value === normalizedValue ? value : `${value} (normalized: ${normalizedValue})`;
        return {
          isValid: false,
          expectedType: attrInfo.type,
          allowedValues: attrInfo.enumValues,
          errorMessage: `Value '${displayValue}' is not allowed. Expected one of: ${attrInfo.enumValues.join(', ')}`
        };
      }

      // 4. Length restrictions
      if (attrInfo.minLength !== undefined && normalizedValue.length < attrInfo.minLength) {
        const displayValue = value === normalizedValue ? value : `${value} (normalized: ${normalizedValue})`;
        return {
          isValid: false,
          expectedType: attrInfo.type,
          errorMessage: `Value '${displayValue}' is too short. Minimum length: ${attrInfo.minLength}, actual: ${normalizedValue.length}`
        };
      }

      if (attrInfo.maxLength !== undefined && normalizedValue.length > attrInfo.maxLength) {
        const displayValue = value === normalizedValue ? value : `${value} (normalized: ${normalizedValue})`;
        return {
          isValid: false,
          expectedType: attrInfo.type,
          errorMessage: `Value '${displayValue}' is too long. Maximum length: ${attrInfo.maxLength}, actual: ${normalizedValue.length}`
        };
      }

      // 4. Basic type validation and numeric ranges
      const basicValidation = this.validateBasicType(normalizedValue, attrInfo.type || '');
      if (!basicValidation.isValid) {
        return basicValidation;
      }

      // 5. Numeric range validation (only for numeric types)
      const baseType = this.resolveToBuiltinType(attrInfo.type || '');
      if (this.isBuiltinNumericType(baseType)) {
        const numValue = parseFloat(normalizedValue.trim());
        if (!isNaN(numValue)) {
          if (attrInfo.minInclusive !== undefined && numValue < attrInfo.minInclusive) {
            return {
              isValid: false,
              expectedType: attrInfo.type,
              errorMessage: `Value ${numValue} is below minimum allowed value ${attrInfo.minInclusive}`
            };
          }

          if (attrInfo.maxInclusive !== undefined && numValue > attrInfo.maxInclusive) {
            return {
              isValid: false,
              expectedType: attrInfo.type,
              errorMessage: `Value ${numValue} is above maximum allowed value ${attrInfo.maxInclusive}`
            };
          }

          if (attrInfo.minExclusive !== undefined && numValue <= attrInfo.minExclusive) {
            return {
              isValid: false,
              expectedType: attrInfo.type,
              errorMessage: `Value ${numValue} must be greater than ${attrInfo.minExclusive}`
            };
          }

          if (attrInfo.maxExclusive !== undefined && numValue >= attrInfo.maxExclusive) {
            return {
              isValid: false,
              expectedType: attrInfo.type,
              errorMessage: `Value ${numValue} must be less than ${attrInfo.maxExclusive}`
            };
          }
        }
      }

      // All validations passed
      return {
        isValid: true,
        expectedType: attrInfo.type,
        restrictions: restrictions.length > 0 ? restrictions : undefined
      };
    } finally {
      if (__profiling) this.profEnd('validateValueWithRestrictions', __t0);
    }
  }

  /**
   * Check if a built-in XSD type is numeric (based on actual XSD built-in types)
   */
  /**
   * Check if a built-in XSD type is numeric (based on actual XSD built-in types)
   * @param builtinType The built-in XSD type to check
   * @returns True if the type is numeric, false otherwise
   */
  private isBuiltinNumericType(builtinType: string): boolean {
    return Schema.numericTypes.has(builtinType);
  }

  /**
   * Validate basic XSD types based on actual XSD definitions, not hardcoded assumptions
   */
  private validateBasicType(value: string, typeName: string): AttributeValidationResult {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // If no type specified, assume valid
      if (!typeName) {
        return { isValid: true };
      }

      // Get the type definition from XSD
      const typeInfo = this.getTypeValidationInfo(typeName);

      // If we have specific validation rules from XSD, those take precedence
      if (typeInfo.patterns && typeInfo.patterns.length > 0) {
        // Pattern validation is already handled in validateValueWithRestrictions
        // This is just a fallback validation
        return { isValid: true, expectedType: typeName };
      }

      if (typeInfo.enumValues && typeInfo.enumValues.length > 0) {
        // Enumeration validation is already handled in validateValueWithRestrictions
        // This is just a fallback validation
        return { isValid: true, expectedType: typeName };
      }

      // Check if this is a built-in XSD type by examining the actual base type chain
      const baseType = this.resolveToBuiltinType(typeName);

      // Validate against the resolved built-in type
      return this.validateBuiltinXsdType(value, baseType, typeName);
    } finally {
      if (__profiling) this.profEnd('validateBasicType', __t0);
    }
  }

  /**
   * Resolve a type name to its ultimate built-in XSD type
   */
  private resolveToBuiltinType(typeName: string): string {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // If it's already a built-in XSD type, return as-is
      if (typeName.startsWith('xs:')) {
        return typeName;
      }

      // Look up the type definition
      const typeNode = this.schemaIndex.types[typeName];
      if (!typeNode) {
        // Unknown type, assume string
        return 'xs:string';
      }

      // Look for restriction base
      const restrictions = this.findChildElements(typeNode, 'restriction');

      if (restrictions.length > 0) {
        const baseType = restrictions[0].getAttribute('base');
        if (baseType) {
          // Recursively resolve the base type
          return this.resolveToBuiltinType(baseType);
        }
      }

      // Look for extension base
      const extensions = this.findChildElements(typeNode, 'extension');
      if (extensions.length > 0) {
        const baseType = extensions[0].getAttribute('base');
        if (baseType) {
          // Recursively resolve the base type
          return this.resolveToBuiltinType(baseType);
        }
      }

      // Look for union types
      const unions = this.findChildElements(typeNode, 'union');
      if (unions.length > 0) {
        const memberTypes = unions[0].getAttribute('memberTypes');
        if (memberTypes) {
          // Split memberTypes by whitespace to get individual type names
          const typeNames = memberTypes.trim().split(/\s+/);

          // For union types, we need to determine the most appropriate built-in type
          // Priority: if any member is numeric, prefer numeric; otherwise default to string
          for (const memberTypeName of typeNames) {
            if (memberTypeName) {
              const resolvedMemberType = this.resolveToBuiltinType(memberTypeName);

              // If we find a numeric type, use it (numeric types are more restrictive)
              if (this.isBuiltinNumericType(resolvedMemberType)) {
                return resolvedMemberType;
              }

              // If we find a boolean type, use it
              if (resolvedMemberType === 'xs:boolean') {
                return resolvedMemberType;
              }
            }
          }

          // If no specific type found, default to string (most permissive)
          return 'xs:string';
        }
      }

      // If no base type found, assume string
      return 'xs:string';
    } finally {
      if (__profiling) {
        this.profEnd('resolveToBuiltinType', __t0);
      }
    }
  }

  /**
   * Helper method to find child elements by name
   */
  private findChildElements(parent: Element, elementName: string): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const results: Element[] = [];

      const searchInNode = (node: Element): void => {
        if (node.localName === elementName) {
          results.push(node);
          return; // Don't recurse into found elements
        }

        // Search immediate children only (not deep recursion)
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            searchInNode(child as Element);
          }
        }
      };

      searchInNode(parent);
      return results;
    } finally {
      if (__profiling) this.profEnd('findChildElements', __t0);
    }
  }

  /**
   * Validate against built-in XSD types only
   */
  private validateBuiltinXsdType(value: string, builtinType: string, originalType: string): AttributeValidationResult {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      switch (builtinType) {
        case 'xs:string':
          // All strings are valid
          return { isValid: true, expectedType: originalType };

        case 'xs:boolean':
          const lowerValue = value.toLowerCase().trim();
          const isValidBoolean = ['true', 'false', '1', '0'].includes(lowerValue);
          return {
            isValid: isValidBoolean,
            expectedType: originalType,
            errorMessage: isValidBoolean ? undefined : `Expected boolean value (true, false, 1, 0), got '${value}'`
          };

        case 'xs:int':
        case 'xs:integer':
        case 'xs:long':
        case 'xs:short':
        case 'xs:byte':
        case 'xs:positiveInteger':
        case 'xs:negativeInteger':
        case 'xs:nonPositiveInteger':
        case 'xs:nonNegativeInteger':
        case 'xs:unsignedInt':
        case 'xs:unsignedLong':
        case 'xs:unsignedShort':
        case 'xs:unsignedByte':
          const isValidInteger = /^-?\d+$/.test(value.trim());
          return {
            isValid: isValidInteger,
            expectedType: originalType,
            errorMessage: isValidInteger ? undefined : `Expected integer value, got '${value}'`
          };

        case 'xs:float':
        case 'xs:double':
        case 'xs:decimal':
          const isValidNumber = /^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(value.trim()) || /^-?\d+$/.test(value.trim());
          return {
            isValid: isValidNumber,
            expectedType: originalType,
            errorMessage: isValidNumber ? undefined : `Expected numeric value, got '${value}'`
          };

        case 'xs:date':
          // Basic date format validation (YYYY-MM-DD)
          const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
          return {
            isValid: isValidDate,
            expectedType: originalType,
            errorMessage: isValidDate ? undefined : `Expected date format (YYYY-MM-DD), got '${value}'`
          };

        case 'xs:time':
          // Basic time format validation (HH:MM:SS)
          const isValidTime = /^\d{2}:\d{2}:\d{2}$/.test(value.trim());
          return {
            isValid: isValidTime,
            expectedType: originalType,
            errorMessage: isValidTime ? undefined : `Expected time format (HH:MM:SS), got '${value}'`
          };

        default:
          // For unknown built-in types or custom types, assume valid
          // The specific validation rules should be handled by patterns/enums
          return { isValid: true, expectedType: originalType };
      }
    } finally {
      if (__profiling) this.profEnd('validateBuiltinXsdType', __t0);
    }
  }

  /**
   * Find element using top-down hierarchy search
   * @param elementName The element to find
   * @param topDownHierarchy Hierarchy from root to immediate parent [root, ..., immediate_parent]
   * @returns Element definition if found, undefined otherwise
   */
  private findElementTopDown(elementName: string, topDownHierarchy: string[]): Element | undefined {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (topDownHierarchy.length === 0) {
        // No hierarchy - look for global elements
        const globalElements = this.getGlobalElementDefinitions(elementName);
        return globalElements.length > 0 ? globalElements[0] : undefined;
      }

      // Start from root and walk down the hierarchy
      const rootElementName = topDownHierarchy[0];
      let currentDefs = this.getGlobalElementOrTypeDefs(rootElementName);

      if (currentDefs.length !== 1) {
        return undefined;
      }

      // Walk down through each level of the hierarchy
      for (let level = 1; level < topDownHierarchy.length; level++) {
        const nextElementName = topDownHierarchy[level];
        const nextLevelDefs: Element[] = [];

        // Search for the next element in all current definitions
        for (const currentDef of currentDefs) {
          const found = this.findElementsInDefinition(currentDef, nextElementName);
          nextLevelDefs.push(...found);
        }

        if (nextLevelDefs.length === 0) {
          return undefined; // Path broken - element not found at this level
        }

        currentDefs = nextLevelDefs;
      }

      // Now search for the target element in the final parent definitions
      const targetElements: Element[] = [];
      for (const parentDef of currentDefs) {
        const found = this.findElementsInDefinition(parentDef, elementName);
        targetElements.push(...found);
      }

      // Return the first found element (could add uniqueness logic here later)
      return targetElements.length > 0 ? targetElements[0] : undefined;
    } finally {
      if (__profiling) this.profEnd('findElementTopDown', __t0);
    }
  }

  /**
   * Get the element source location: file URI and position in the source file.
   * Uses the 'data-source-file' and 'start-tag-length' annotations (added during XSD load) and line/column info on the Element.
   * Returns undefined if source file is unknown.
   */
  public static getElementLocation(element: Element): ElementLocation | undefined {
    if (!element) return undefined;
    const filePath = element.getAttribute && element.getAttribute('data-source-file');
    if (!filePath) return undefined;
    const location: ElementLocation = {
      uri: pathToFileURL(filePath).toString(),
      line: 1,
      column: 1,
      lengthOfStartTag: 1
    };

    // Read line/column if provided by the DOM parser; fall back to 1-based defaults.
    const anyEl = element as any;
    let line: number | undefined = anyEl.lineNumber ?? anyEl.line;
    let column: number | undefined = anyEl.columnNumber ?? anyEl.col ?? anyEl.column;
    if (typeof line !== 'number' || isNaN(line)) return undefined;
    if (typeof column !== 'number' || isNaN(column)) return undefined;
    location.line = line;
    location.column = column;
    const lengthAttr = element.getAttribute('start-tag-length');
    if (!(lengthAttr === null || lengthAttr === undefined)) {
      location.lengthOfStartTag = parseInt(lengthAttr, 10) || 1;
    }
    return location;
  }

  /**
   * Extract annotation text from an XSD element's xs:annotation/xs:documentation
   */
  public static extractAnnotationText(element: Element): string | undefined {
    // Look for xs:annotation child element
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];
      if (child.nodeType === 1 && (child as Element).localName === 'annotation') {
        const annotationElement = child as Element;

        // Look for xs:documentation within xs:annotation
        for (let j = 0; j < annotationElement.childNodes.length; j++) {
          const docChild = annotationElement.childNodes[j];
          if (docChild.nodeType === 1 && (docChild as Element).localName === 'documentation') {
            const docElement = docChild as Element;

            // Get the text content
            const textContent = docElement.textContent;
            if (textContent && textContent.trim()) {
              return textContent.trim();
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Extract enum value annotations from a type definition
   * @param typeNode The type definition element to extract enum annotations from
   * @returns Map of enum values to their annotation text
   */
  private extractEnumValueAnnotations(typeNode: Element): Map<string, string> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const annotations = new Map<string, string>();
      const extractFromNode = (node: Element): void => {
        if (!node || node.nodeType !== 1) return;

        // Check if this is an enumeration element
        if (node.localName === 'enumeration') {
          const value = node.getAttribute('value');
          if (value) {
            const annotationText = Schema.extractAnnotationText(node);
            if (annotationText) {
              annotations.set(value, annotationText);
            }
          }
        }

        // Recursively search child nodes
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            extractFromNode(child as Element);
          }
        }
      };

      extractFromNode(typeNode);
      return annotations;
    } finally {
      if (__profiling) {
        this.profEnd('extractEnumValueAnnotations', __t0);
      }
    }
  }

  /**
   * Get possible child elements for a given element by name and hierarchy
   * @param elementName The parent element name
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   * @param previousSibling Optional previous sibling element name to filter results based on sequence constraints
   * @returns Map where key is child element name and value is its annotation text
   */
  public getPossibleChildElements(elementName: string, hierarchy: string[] = [], previousSibling: string = ''): Map<string, string> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      let tDef = 0, tFindAll = 0, tFilter = 0, tAnnot = 0;

      // Fast-path cache for final result
      const resultCache = this.cache.possibleChildrenResultCache;

      // Get the element definition using the same logic as other methods
      const tDef0 = (globalThis.performance?.now?.() ?? Date.now());
      const elementDef = this.getElementDefinition(elementName, hierarchy);
      tDef += (globalThis.performance?.now?.() ?? Date.now()) - tDef0;

      if (!elementDef) {
        return new Map<string, string>();
      }
      let cachedMap = resultCache.get(elementDef);
      if (cachedMap) {
        if (cachedMap.has(previousSibling)) {
          if (this.shouldProfileCaches) this.cacheStats.possibleChildrenResultCache.hits++;
          return new Map(cachedMap.get(previousSibling));
        }
      } else {
        cachedMap = new Map();
        resultCache.set(elementDef, cachedMap);
      }

      // Get all possible child elements
      const tFindAll0 = (globalThis.performance?.now?.() ?? Date.now());
      const childElements = this.findAllElementsInDefinition(elementDef);
      tFindAll += (globalThis.performance?.now?.() ?? Date.now()) - tFindAll0;

      let filteredElements: Element[];
      const prevSibling = previousSibling ? childElements.find(el => el.getAttribute('name') === previousSibling) : undefined;
      // If previousSibling is provided, filter based on sequence/choice constraints
      if (previousSibling && prevSibling) {
        const tFilter0 = (globalThis.performance?.now?.() ?? Date.now());
        filteredElements = this.filterElementsBySequenceConstraints(elementDef, childElements, prevSibling);
        tFilter += (globalThis.performance?.now?.() ?? Date.now()) - tFilter0;
      } else {
        // No previous sibling: honor the content model and only return start-capable elements
        const tFilter0 = (globalThis.performance?.now?.() ?? Date.now());
        const contentModel = this.getCachedContentModel(elementDef);
        if (contentModel) {
          const modelType = contentModel.localName;
          if (modelType === 'choice') {
            filteredElements = this.getElementsInChoice(contentModel, childElements);
          } else if (modelType === 'sequence') {
            filteredElements = this.getStartElementsOfSequence(contentModel, childElements);
          } else if (modelType === 'all') {
            // For xs:all, any element can start
            filteredElements = childElements;
          } else {
            filteredElements = childElements;
          }
        } else {
          filteredElements = childElements;
        }
        tFilter += (globalThis.performance?.now?.() ?? Date.now()) - tFilter0;
      }

      const result = new Map<string, string>();

      // Build result map with annotations
      const tAnnot0 = (globalThis.performance?.now?.() ?? Date.now());
      for (const element of filteredElements) {
        const name = element.getAttribute('name');
        if (!name) continue;
        const annotation = this.getAnnotationCached(element);
        result.set(name, annotation);
      }
      tAnnot += (globalThis.performance?.now?.() ?? Date.now()) - tAnnot0;

      // Cache the final result map for fast retrieval
      cachedMap.set(previousSibling, result);
      if (this.shouldProfileCaches) this.cacheStats.possibleChildrenResultCache.sets++;
      // Optional profiling output
      if ((process.env.XSDL_PROFILE_CHILDREN || '').trim() === '1') {
        const msg = `getPossibleChildElements(${elementName}) -> ${result.size} children; def=${tDef.toFixed(3)}ms; findAll=${tFindAll.toFixed(3)}ms; filter=${tFilter.toFixed(3)}ms; annot=${tAnnot.toFixed(3)}ms`;
        // eslint-disable-next-line no-console
        console.log(msg);
      }
      return result;
    } finally {
      if (__profiling) this.profEnd('getPossibleChildElements', __t0);
    }
  }

  /**
   * Check if a specific element is valid as a child of a given parent in the provided hierarchy,
   * using the same engine and constraints as getPossibleChildElements, but without calling it directly.
   *
   * Contract:
   * - Inputs: elementName, parentName, parentHierarchy (bottom-up: [immediate_parent, ..., root]), optional previousSibling
   * - Output: boolean indicating if elementName can appear next under parentName respecting content model and sequence rules
   */
  public isValidChild(
    elementName: string,
    parentName: string,
    parentHierarchy: string[] = [],
    previousSibling?: string
  ): boolean {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Memoized cache by resolved parent Element and previousSibling
      // Resolve the parent element definition within the provided hierarchy
      const parentDef = this.getElementDefinition(parentName, parentHierarchy);
      if (!parentDef) return false;

      // Fast path: cache per parentDef -> prevKey -> childName
      const prevKey = previousSibling || '__START__';
      let byPrev = this.cache.validChildCache!.get(parentDef);
      if (!byPrev) { byPrev = new Map(); this.cache.validChildCache!.set(parentDef, byPrev); }
      let byChild = byPrev.get(prevKey);
      if (!byChild) { byChild = new Map(); byPrev.set(prevKey, byChild); }
      if (byChild.has(elementName)) { if (this.shouldProfileCaches) this.cacheStats.validChildCache.hits++; return byChild.get(elementName)!; }
      this.cacheStats.validChildCache.misses++
      // Discover all immediate child element candidates (cached)
      const allChildren = this.findAllElementsInDefinition(parentDef);
      if (allChildren.length === 0) { byChild.set(elementName, false); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return false; }

      // Find the concrete Element node for the requested child; if not declared, it's invalid
      const candidate = allChildren.find(el => el.getAttribute('name') === elementName);
      if (!candidate) { byChild.set(elementName, false); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return false; }

      // If there is no ordering constraint or xs:all, declaration is sufficient
      const contentModel = this.getCachedContentModel(parentDef);

      const prevSibling = allChildren.find(el => el.getAttribute('name') === previousSibling);
      if (!previousSibling || !prevSibling) {
        if (!contentModel) { byChild.set(elementName, true); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return true; }
        const modelType = contentModel.localName;
        if (modelType === 'all') { byChild.set(elementName, true); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return true; }
        if (modelType === 'choice') {
          // Check if the candidate can start any alternative in the choice
          const startSet = this.getModelStartSet(contentModel, allChildren);
          const ok = startSet.has(elementName);
          byChild.set(elementName, ok); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++;
          return ok;
        }
        if (modelType === 'sequence') {
          // Check if the candidate can start the sequence (respecting minOccurs chain)
          const startSet = this.getModelStartSet(contentModel, allChildren);
          const ok = startSet.has(elementName);
          byChild.set(elementName, ok); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++;
          return ok;
        }
        // Unknown model type: be permissive like getPossibleChildElements fallback
        byChild.set(elementName, true); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++;
        return true;
      }

      // There is a previous sibling; handle ordering constraints efficiently by filtering only the candidate
      if (!contentModel) { byChild.set(elementName, true); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return true; }
      if (contentModel.localName === 'all') { byChild.set(elementName, true); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++; return true; }
      // Use cached next-name set for this content model and previous sibling
      const nextSet = this.getModelNextSet(contentModel, previousSibling, prevSibling, allChildren);
      const ok = nextSet.has(elementName);
      byChild.set(elementName, ok); if (this.shouldProfileCaches) this.cacheStats.validChildCache.sets++;
      return ok;
    } finally {
      if (__profiling) this.profEnd('isValidChild', __t0);
    }
  }

  // Compute and cache start-name set for a content model
  private getModelStartSet(model: Element, allChildren: Element[]): Set<string> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      let cached = this.cache.modelStartNamesCache!.get(model);
      if (cached) { if (this.shouldProfileCaches) this.cacheStats.modelStartNamesCache.hits++; return cached; }
      if (this.shouldProfileCaches) this.cacheStats.modelStartNamesCache.misses++;
      let starters: Element[] = [];
      if (model.localName === 'choice' || model.localName === 'all') {
        starters = this.getElementsInChoice(model, allChildren);
      } else if (model.localName === 'sequence') {
        starters = this.getStartElementsOfSequence(model, allChildren);
      } else {
        // Fallback: allow any declared children to start
        starters = allChildren;
      }
      const set = new Set(starters.map(e => e.getAttribute('name')!).filter(Boolean) as string[]);
      this.cache.modelStartNamesCache!.set(model, set);
      if (this.shouldProfileCaches) this.cacheStats.modelStartNamesCache.sets++;
      return set;
    } finally {
      if (__profiling) this.profEnd('getModelStartSet', __t0);
    }
  }

  // Compute and cache next-name set for a content model given previous sibling
  private getModelNextSet(model: Element, previousSibling: string, prevSibling: Element, allChildren: Element[]): Set<string> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      let byPrev = this.cache.modelNextNamesCache!.get(model);
      if (!byPrev) { byPrev = new Map(); this.cache.modelNextNamesCache!.set(model, byPrev); }
      const prevKey = previousSibling || '__START__';
      const existing = byPrev.get(prevKey);
      if (existing) { if (this.shouldProfileCaches) this.cacheStats.modelNextNamesCache.hits++; return existing; }
      if (this.shouldProfileCaches) this.cacheStats.modelNextNamesCache.misses++;
      const nextElems = this.getValidNextElementsInContentModel(model, prevSibling, allChildren);
      const set = new Set(nextElems.map(e => e.getAttribute('name')!).filter(Boolean) as string[]);
      byPrev.set(prevKey, set);
      if (this.shouldProfileCaches) this.cacheStats.modelNextNamesCache.sets++;
      return set;
    } finally {
      if (__profiling) this.profEnd('getModelNextSet', __t0);
    }
  }

  /**
   * Filter child elements based on XSD sequence constraints and previous sibling
   * @param elementDef The parent element definition
   * @param allChildren All possible child elements
   * @param previousSibling The name of the previous sibling element
   * @returns Filtered array of elements that are valid as next elements
   */
  private filterElementsBySequenceConstraints(elementDef: Element, allChildren: Element[], previousSibling: Element): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Find the content model (sequence/choice) within the element definition (cached)
      const contentModel = this.getCachedContentModel(elementDef);

      if (!contentModel) {
        // If no content model found, return all children (fallback)
        return allChildren;
      }

      // Apply filtering based on content model type
      return this.getValidNextElementsInContentModel(contentModel, previousSibling, allChildren);
    } finally {
      if (__profiling) this.profEnd('filterElementsBySequenceConstraints', __t0);
    }
  }

  // Note: Sequence and choice handling is fully data-driven from the XSD; no element-name
  // special-casing is implemented here.

  /**
   * Find the content model (sequence/choice/all) within an element definition
   * @param elementDef The element definition to search
   * @returns The content model element, or null if not found
   */
  private findContentModel(elementDef: Element): Element | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // If the node itself is already a content model, return it
      if (elementDef.localName === 'sequence' || elementDef.localName === 'choice' || elementDef.localName === 'all') {
        return elementDef;
      }

      // If the node is a group (definition or ref), resolve to its direct content model
      if (elementDef.localName === 'group') {
        const ref = elementDef.getAttribute('ref');
        const groupNode = ref ? this.schemaIndex.groups[ref] : elementDef;
        if (groupNode) {
          const direct = this.findDirectContentModel(groupNode);
          if (direct) return direct;
        }
      }

      // If this is a complexType or content extension/restriction, find direct content model
      if (elementDef.localName === 'complexType' ||
        elementDef.localName === 'complexContent' ||
        elementDef.localName === 'simpleContent' ||
        elementDef.localName === 'extension' ||
        elementDef.localName === 'restriction') {
        const direct = this.findDirectContentModel(elementDef);
        if (direct) return direct;
      }

      // Look for complexType first
      for (let i = 0; i < elementDef.childNodes.length; i++) {
        const child = elementDef.childNodes[i];
        if (child.nodeType === 1 && (child as Element).localName === 'complexType') {
          const complexType = child as Element;

          // Direct sequence/choice/all in complexType
          const directModel = this.findDirectContentModel(complexType);
          if (directModel) {
            return directModel;
          }
        }
      }

      // Look for type reference and follow it
      const typeAttr = elementDef.getAttribute('type');
      if (typeAttr && !this.isBuiltInXsdType(typeAttr)) {
        const typeDef = this.schemaIndex.types[typeAttr] || this.schemaIndex.types[typeAttr.replace(/^.*:/, '')];
        if (typeDef) {
          return this.getCachedContentModel(typeDef);
        }
      }

      return null;
    } finally {
      if (__profiling) this.profEnd('findContentModel', __t0);
    }
  }

  // Cached content model resolver
  private getCachedContentModel(def: Element): Element | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const cache = this.cache.contentModelCache!;
      if (cache.has(def)) { if (this.shouldProfileCaches) this.cacheStats.contentModelCache.hits++; return cache.get(def)!; }
      if (this.shouldProfileCaches) this.cacheStats.contentModelCache.misses++;
      const model = this.findContentModel(def);
      cache.set(def, model);
      if (this.shouldProfileCaches) this.cacheStats.contentModelCache.sets++;
      return model;
    } finally {
      if (__profiling) this.profEnd('getCachedContentModel', __t0);
    }
  }

  // Cached annotation extraction with type fallback
  private getAnnotationCached(el: Element): string {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const cache = this.cache.annotationCache!;
      const existing = cache.get(el);
      if (existing !== undefined) { if (this.shouldProfileCaches) this.cacheStats.annotationCache.hits++; return existing; }
      if (this.shouldProfileCaches) this.cacheStats.annotationCache.misses++;
      let annotation = Schema.extractAnnotationText(el) || '';
      if (!annotation) {
        const typeName = el.getAttribute('type');
        if (typeName) {
          const typeDef = this.schemaIndex.types[typeName];
          if (typeDef) {
            annotation = Schema.extractAnnotationText(typeDef) || '';
          }
        }
      }
      cache.set(el, annotation);
      if (this.shouldProfileCaches) this.cacheStats.annotationCache.sets++;
      return annotation;
    } finally {
      if (__profiling) this.profEnd('getAnnotationCached', __t0);
    }
  }

  /**
   * Find direct content model in a complexType, extension, or restriction
   * @param parent The parent element to search in
   * @returns The content model element, or null if not found
   */
  private findDirectContentModel(parent: Element): Element | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i];
        if (child.nodeType === 1) {
          const element = child as Element;

          // Direct sequence/choice/all
          if (element.localName === 'sequence' ||
            element.localName === 'choice' ||
            element.localName === 'all') {
            return element;
          }

          // Look in extension/restriction
          if (element.localName === 'extension' || element.localName === 'restriction') {
            const nested = this.findDirectContentModel(element);
            if (nested) {
              return nested;
            }
          }

          // Follow group references to find underlying content model
          if (element.localName === 'group') {
            const ref = element.getAttribute('ref');
            if (ref) {
              const groupDef = this.schemaIndex.groups[ref];
              if (groupDef) {
                const nested = this.findDirectContentModel(groupDef);
                if (nested) {
                  return nested;
                }
              }
            }
          }
        }
      }

      return null;
    } finally {
      if (__profiling) this.profEnd('findDirectContentModel', __t0);
    }
  }

  /**
   * Get valid next elements based on content model and previous sibling
   * @param contentModel The sequence/choice/all element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Filtered elements that are valid as next elements
   */
  private getValidNextElementsInContentModel(contentModel: Element, previousSibling: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const modelType = contentModel.localName;

      if (modelType === 'choice') {
        return this.getValidNextInChoice(contentModel, previousSibling, allChildren);
      } else if (modelType === 'sequence') {
        return this.getValidNextInSequence(contentModel, previousSibling, allChildren);
      } else if (modelType === 'all') {
        // For all, any unused element can come next
        return allChildren; // Simplified - could be enhanced to track used elements
      }

      // Unknown model type, return all children
      return allChildren;
    } finally {
      if (__profiling) this.profEnd('getValidNextElementsInContentModel', __t0);
    }
  }

  /**
   * Get valid next elements in a choice based on previous sibling
   * @param choice The choice element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Valid next elements
   */
  private getValidNextInChoice(choice: Element, previousSibling: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // If previousSibling belongs to a nested sequence option within this choice,
      // continue inside that same sequence arm and also allow restarting that arm (choice repetition).
      // IMPORTANT: Prefer scanning the direct alternatives of this choice first to avoid
      // accidentally picking outer sequences (e.g., the actions sequence) that contain the element indirectly.
      let nestedSeq: Element | null = null;
      for (let i = 0; i < choice.childNodes.length && !nestedSeq; i++) {
        const alt = choice.childNodes[i];
        if (alt.nodeType !== 1) continue;
        const el = alt as Element;
        if (el.localName === 'sequence') {
          if (this.itemContainsElement(el, previousSibling)) {
            nestedSeq = el;
            break;
          }
        } else if (el.localName === 'group') {
          const ref = el.getAttribute('ref');
          const grp = ref ? this.schemaIndex.groups[ref] : el;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model && model.localName === 'choice') {
              for (let j = 0; j < model.childNodes.length && !nestedSeq; j++) {
                const mchild = model.childNodes[j];
                if (mchild.nodeType !== 1) continue;
                const mEl = mchild as Element;
                if (mEl.localName === 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                  nestedSeq = mEl;
                  break;
                }
              }
            } else if (model && model.localName === 'sequence' && this.itemContainsElement(model, previousSibling)) {
              nestedSeq = model;
              break;
            }
          }
        }
      }
      if (!nestedSeq) {
        // Fallback: broader search that resolves groups and nested structures
        nestedSeq = this.findNestedSequenceContainingElement(choice, previousSibling);
      }
      if (nestedSeq) {
        // Build a list of direct element items in the nested sequence along with occurs
        const items: { name: string; minOccurs: number; maxOccurs: number | 'unbounded' }[] = [];
        for (let i = 0; i < nestedSeq.childNodes.length; i++) {
          const child = nestedSeq.childNodes[i];
          if (child.nodeType !== 1) continue;
          const el = child as Element;
          if (el.localName === 'element') {
            const name = el.getAttribute('name');
            if (!name) continue;
            const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
            const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
            items.push({ name, minOccurs, maxOccurs });
          }
          // Note: nested structures inside the nested sequence are not expected in this arm
        }

        const allowed = new Set<string>();
        const previousSiblingName = previousSibling.getAttribute('name');
        const prevIndex = items.findIndex(it => it.name === previousSiblingName);
        if (prevIndex !== -1) {
          // 1) Repetition of the current element if allowed
          const cur = items[prevIndex];
          if (cur.maxOccurs === 'unbounded' || (typeof cur.maxOccurs === 'number' && cur.maxOccurs > 1)) {
            allowed.add(cur.name);
          }

          // 2) Subsequent items until we hit a required one (inclusive)
          for (let i = prevIndex + 1; i < items.length; i++) {
            allowed.add(items[i].name);
            if (items[i].minOccurs >= 1) break;
          }
        }

        // 3) Because the choice can typically repeat, allow restarting the same sequence arm
        const seqStarts = this.getStartElementsOfSequence(nestedSeq, allChildren).map(e => e.getAttribute('name')!).filter(Boolean) as string[];
        for (const n of seqStarts) allowed.add(n);

        // Map back to actual Element nodes
        const results: Element[] = [];
        for (const name of allowed) {
          const el = allChildren.find(e => e.getAttribute('name') === name);
          if (el) results.push(el);
        }
        // Deduplicate preserving insertion order already handled by Set
        return results;
      }

      // Otherwise, we are at the start of a choice occurrence; return only the start elements of each alternative.
      return this.getElementsInChoice(choice, allChildren);
    } finally {
      if (__profiling) this.profEnd('getValidNextInChoice', __t0);
    }
  }

  /**
   * Get valid next elements in a sequence based on previous sibling
   * @param sequence The sequence element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Valid next elements in the sequence
   */
  private getValidNextInSequence(sequence: Element, previousSibling: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const sequenceItems: Element[] = [];

      // Collect all sequence items (elements, choices, groups, etc.)
      for (let i = 0; i < sequence.childNodes.length; i++) {
        const child = sequence.childNodes[i];
        if (child.nodeType === 1) {
          sequenceItems.push(child as Element);
        }
      }

      // Find the position of the previous sibling in the sequence
      let previousPosition = -1;
      let previousItem: Element | null = null;

      const previousSiblingName = previousSibling.getAttribute('name');

      for (let i = 0; i < sequenceItems.length; i++) {
        const item = sequenceItems[i];

        if (this.itemContainsElement(item, previousSibling)) {
          previousPosition = i;
          previousItem = item;
          break;
        }
      }

      if (previousPosition === -1) {
        // Previous sibling not found in this sequence, return all children
        return allChildren;
      }

      const validNext: Element[] = [];

      // If the previous item is a choice, we should only allow continuation inside the alternative that contains previousSibling.
      // Track non-start elements from sequence alternatives to avoid leaking them when not inside that sequence arm.
      let prevChoiceNonStart: Set<string> | null = null;
      let nestedChoiceAllowedNames: Set<string> | null = null;
      if (previousItem && previousItem.localName === 'choice') {
        // Prefer direct alternative scan first
        let nestedSeq: Element | null = null;
        for (let i = 0; i < previousItem.childNodes.length && !nestedSeq; i++) {
          const alt = previousItem.childNodes[i];
          if (alt.nodeType !== 1) continue;
          const el = alt as Element;
          if (el.localName === 'sequence') {
            if (this.itemContainsElement(el, previousSibling)) {
              nestedSeq = el;
              break;
            }
          } else if (el.localName === 'group') {
            const ref = el.getAttribute('ref');
            const grp2 = ref ? this.schemaIndex.groups[ref] : el;
            if (grp2) {
              const model2 = this.findDirectContentModel(grp2);
              if (model2 && model2.localName === 'choice') {
                for (let j = 0; j < model2.childNodes.length && !nestedSeq; j++) {
                  const mchild = model2.childNodes[j];
                  if (mchild.nodeType !== 1) continue;
                  const mEl = mchild as Element;
                  if (mEl.localName === 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                    nestedSeq = mEl;
                    break;
                  }
                }
              } else if (model2 && model2.localName === 'sequence' && this.itemContainsElement(model2, previousSibling)) {
                nestedSeq = model2;
                break;
              }
            }
          }
        }
        if (!nestedSeq) {
          // Fallback: broader nested search
          nestedSeq = this.findNestedSequenceContainingElement(previousItem, previousSibling);
        }
        if (nestedSeq) {
          // Non-recursive computation for the nested sequence arm containing previousSibling
          const items: { name: string; minOccurs: number; maxOccurs: number | 'unbounded' }[] = [];
          for (let i = 0; i < nestedSeq.childNodes.length; i++) {
            const child = nestedSeq.childNodes[i];
            if (child.nodeType !== 1) continue;
            const el = child as Element;
            if (el.localName === 'element') {
              const name = el.getAttribute('name');
              if (!name) continue;
              const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
              const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
              items.push({ name, minOccurs, maxOccurs });
            }
          }
          const allowedNames = new Set<string>();
          const prevIndex = items.findIndex(it => it.name === previousSiblingName);
          if (prevIndex !== -1) {
            // 1) Repetition of the current element if allowed
            const cur = items[prevIndex];
            if (cur.maxOccurs === 'unbounded' || (typeof cur.maxOccurs === 'number' && cur.maxOccurs > 1)) {
              allowedNames.add(cur.name);
            }
            // 2) Subsequent items until first required (inclusive)
            for (let i = prevIndex + 1; i < items.length; i++) {
              allowedNames.add(items[i].name);
              if (items[i].minOccurs >= 1) break;
            }
          }
          // 3) Allow restarting the same arm (choice repetition)
          const seqStarts = this.getStartElementsOfSequence(nestedSeq, allChildren);
          for (const e of seqStarts) {
            const n = e.getAttribute('name');
            if (n) allowedNames.add(n);
          }
          // Remember allowed names coming from the nested choice arm
          nestedChoiceAllowedNames = new Set(allowedNames);
          // Map to actual Element nodes
          for (const name of allowedNames) {
            const el = allChildren.find(e => e.getAttribute('name') === name);
            if (el) validNext.push(el);
          }
        } else {
          // previousSibling was one of the direct choice elements; allow following mandatory/optional items of outer sequence
          for (let i = previousPosition + 1; i < sequenceItems.length; i++) {
            const nextItem = sequenceItems[i];
            const starts = this.getStartElementsFromItem(nextItem, allChildren);
            validNext.push(...starts);
            const minOccurs = this.getEffectiveMinOccurs(nextItem, sequence);
            if (minOccurs >= 1) break;
          }
        }
        // Compute non-start elements from any sequence alternatives of this choice for later filtering
        prevChoiceNonStart = this.getNonStartElementsInChoiceSequences(previousItem);
      }

      // If the previous item is a group, resolve its underlying model and delegate accordingly
      if (previousItem && previousItem.localName === 'group') {
        const ref = previousItem.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : previousItem;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) {
            if (model.localName === 'choice') {
              // Prefer direct alternative scan first inside the resolved choice
              let nestedSeq: Element | null = null;
              for (let i = 0; i < model.childNodes.length && !nestedSeq; i++) {
                const alt = model.childNodes[i];
                if (alt.nodeType !== 1) continue;
                const el = alt as Element;
                if (el.localName === 'sequence') {
                  if (this.itemContainsElement(el, previousSibling)) {
                    nestedSeq = el;
                    break;
                  }
                } else if (el.localName === 'group') {
                  const ref = el.getAttribute('ref');
                  const grp2 = ref ? this.schemaIndex.groups[ref] : el;
                  if (grp2) {
                    const model2 = this.findDirectContentModel(grp2);
                    if (model2 && model2.localName === 'choice') {
                      for (let j = 0; j < model2.childNodes.length && !nestedSeq; j++) {
                        const mchild = model2.childNodes[j];
                        if (mchild.nodeType !== 1) continue;
                        const mEl = mchild as Element;
                        if (mEl.localName === 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                          nestedSeq = mEl;
                          break;
                        }
                      }
                    } else if (model2 && model2.localName === 'sequence' && this.itemContainsElement(model2, previousSibling)) {
                      nestedSeq = model2;
                      break;
                    }
                  }
                }
              }
              if (!nestedSeq) {
                nestedSeq = this.findNestedSequenceContainingElement(model, previousSibling);
              }
              if (nestedSeq) {
                // Compute allowed names within the nested sequence arm non-recursively
                const items: { name: string; minOccurs: number; maxOccurs: number | 'unbounded' }[] = [];
                for (let i = 0; i < nestedSeq.childNodes.length; i++) {
                  const child = nestedSeq.childNodes[i];
                  if (child.nodeType !== 1) continue;
                  const el = child as Element;
                  if (el.localName === 'element') {
                    const name = el.getAttribute('name');
                    if (!name) continue;
                    const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
                    const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
                    items.push({ name, minOccurs, maxOccurs });
                  }
                }
                const allowedNames = new Set<string>();
                const prevIndex = items.findIndex(it => it.name === previousSiblingName);
                if (prevIndex !== -1) {
                  const cur = items[prevIndex];
                  if (cur.maxOccurs === 'unbounded' || (typeof cur.maxOccurs === 'number' && cur.maxOccurs > 1)) {
                    allowedNames.add(cur.name);
                  }
                  for (let i = prevIndex + 1; i < items.length; i++) {
                    allowedNames.add(items[i].name);
                    if (items[i].minOccurs >= 1) break;
                  }
                }
                const seqStarts = this.getStartElementsOfSequence(nestedSeq, allChildren);
                for (const e of seqStarts) {
                  const n = e.getAttribute('name');
                  if (n) allowedNames.add(n);
                }
                for (const name of allowedNames) {
                  const el = allChildren.find(e => e.getAttribute('name') === name);
                  if (el) validNext.push(el);
                }
              }
            } else if (model.localName === 'sequence') {
              const seqNext = this.getValidNextInSequence(model, previousSibling, allChildren);
              validNext.push(...seqNext);
            } else if (model.localName === 'all') {
              // xs:all has no ordering; allow allChildren
              validNext.push(...allChildren);
            }
          }
        }
      }

      // Note: do not override sibling computation by diving into the previous element's inner model here.

      // Check if the previous item can repeat; use effective maxOccurs (including inheritance from the parent sequence)
      if (previousItem) {
        const prevMaxOccurs = this.getEffectiveMaxOccurs(previousItem, sequence);
        const prevCanRepeat = (prevMaxOccurs === 'unbounded') || (typeof prevMaxOccurs === 'number' && prevMaxOccurs > 1);
        if (prevCanRepeat) {
          if (previousItem.localName === 'choice') {
            // Repeating a choice: allow all alternatives that can start a new occurrence
            validNext.push(...this.getElementsInChoice(previousItem, allChildren));
          } else if (previousItem.localName === 'group') {
            // Repeating a group: respect its underlying model
            const ref = previousItem.getAttribute('ref');
            const grp = ref ? this.schemaIndex.groups[ref] : previousItem;
            if (grp) {
              const model = this.findDirectContentModel(grp);
              if (model && model.localName === 'choice') {
                validNext.push(...this.getElementsInChoice(model, allChildren));
              } else if (model && model.localName === 'sequence') {
                validNext.push(...this.getStartElementsOfSequence(model, allChildren));
              } else {
                const repeatElement = allChildren.find(elem => elem.getAttribute('name') === previousSiblingName);
                if (repeatElement) validNext.push(repeatElement);
              }
            }
          } else if (previousItem.localName === 'sequence') {
            // Repeating a sequence item directly: allow its starts
            validNext.push(...this.getStartElementsOfSequence(previousItem, allChildren));
          } else {
            // Element or other item repeats itself
            const repeatElement = allChildren.find(elem => elem.getAttribute('name') === previousSiblingName);
            if (repeatElement) validNext.push(repeatElement);
          }
        }
      }

      // If the sequence itself can repeat (maxOccurs on xs:sequence), allow restarting the sequence
      const seqMaxRaw = sequence.getAttribute('maxOccurs') || '1';
      const seqCanRepeat = seqMaxRaw === 'unbounded' || (!isNaN(parseInt(seqMaxRaw)) && parseInt(seqMaxRaw) > 1);
      if (seqCanRepeat) {
        validNext.push(...this.getStartElementsOfSequence(sequence, allChildren));
      }

      // Add elements that come after the previous position in the sequence (only when not staying within a nested choice arm)
      for (let i = previousPosition + 1; i < sequenceItems.length; i++) {
        const nextItem = sequenceItems[i];
        const itemElements = this.getElementsFromSequenceItem(nextItem, allChildren);
        validNext.push(...itemElements);

        // If this item is required (minOccurs >= 1), stop here
        // If it's optional (minOccurs = 0), continue to the next items
        const minOccurs = this.getEffectiveMinOccurs(nextItem, sequence);
        if (minOccurs >= 1) {
          break; // Required item found, stop here
        }
      }

      // When previous item is a choice, avoid leaking non-start elements of its sequence alternatives
      if (previousItem && previousItem.localName === 'choice' && prevChoiceNonStart && prevChoiceNonStart.size > 0) {
        const filtered = validNext.filter(e => {
          const name = e.getAttribute('name') || '';
          if (!name) return false;
          if (!prevChoiceNonStart!.has(name)) return true;
          // If we are inside a nested sequence arm, keep only if explicitly allowed from that nested computation
          return nestedChoiceAllowedNames ? nestedChoiceAllowedNames.has(name) : false;
        });
        validNext.length = 0;
        validNext.push(...filtered);
      }

      // Deduplicate preserving order
      const seen = new Set<string>();
      const dedup = validNext.filter(e => {
        const n = e.getAttribute('name') || '';
        if (!n) return false;
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });

      return dedup;
    } finally {
      if (__profiling) this.profEnd('getValidNextInSequence', __t0);
    }
  }


  /**
   * Collect element names that are part of sequence alternatives in a choice but are NOT start elements
   * (i.e., elements that appear at position >= 2 in those sequences). Used to avoid leaking follow-up-only
   * items like do_elseif/do_else when not continuing inside that sequence arm.
   */
  private getNonStartElementsInChoiceSequences(choice: Element): Set<string> {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const names = new Set<string>();

      const collectFromNode = (node: Element) => {
        if (node.localName === 'sequence') {
          let seenFirst = false;
          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType !== 1) continue;
            const el = child as Element;
            if (el.localName === 'element') {
              const nm = el.getAttribute('name');
              if (!nm) continue;
              if (seenFirst) {
                names.add(nm);
              } else {
                seenFirst = true;
              }
            } else if (el.localName === 'group') {
              const ref = el.getAttribute('ref');
              const grp = ref ? this.schemaIndex.groups[ref] : el;
              if (grp) {
                const model = this.findDirectContentModel(grp);
                if (model) collectFromNode(model);
              }
            } else if (el.localName === 'choice' || el.localName === 'sequence') {
              // Dive into nested structures if present
              collectFromNode(el);
            }
          }
        } else if (node.localName === 'group') {
          const ref = node.getAttribute('ref');
          const grp = ref ? this.schemaIndex.groups[ref] : node;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model) collectFromNode(model);
          }
        } else if (node.localName === 'choice') {
          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType === 1) collectFromNode(child as Element);
          }
        }
      };

      // Start from direct alternatives of the choice
      for (let i = 0; i < choice.childNodes.length; i++) {
        const child = choice.childNodes[i];
        if (child.nodeType === 1) collectFromNode(child as Element);
      }

      return names;
    } finally {
      if (__profiling) this.profEnd('getNonStartElementsInChoiceSequences', __t0);
    }
  }

  /**
   * Check if a sequence item (element, choice, group) contains the specified element
   * @param item The sequence item to check
   * @param element The element name to look for
   * @returns True if the item contains the element
   */
  private itemContainsElement(item: Element, element: Element, visited?: Set<Element>): boolean {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Initialize visited set for cycle detection across recursive traversals
      if (!visited) visited = new Set<Element>();
      let cached: WeakMap<Element, boolean> | undefined;
      // Fast path via containsCache keyed by item Element and child name
      const name = element.getAttribute('name') || '';
      if (name) {
        cached = this.cache.containsCache.get(item);
        if (!cached) { cached = new WeakMap<Element, boolean>(); this.cache.containsCache.set(item, cached); }
        const existing = cached.get(element);
        if (existing !== undefined) { if (this.shouldProfileCaches) this.cacheStats.containsCache.hits++; return existing; }
        if (this.shouldProfileCaches) this.cacheStats.containsCache.misses++;
        // We'll compute and store before return below
      }

      if (item.localName === 'element') {
        const res = (item === element);
        if (cached) { cached.set(element, res); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
        return res;
      } else if (item.localName === 'choice') {
        // Check if any element in the choice matches
        const res = this.choiceContainsElement(item, element, visited);
        if (cached) { cached.set(element, res); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
        return res;
      } else if (item.localName === 'sequence') {
        if (!visited.has(item)) {
          visited.add(item);
          // Check any child of the sequence
          for (let i = 0; i < item.childNodes.length; i++) {
            const child = item.childNodes[i];
            if (child.nodeType === 1) {
              if (this.itemContainsElement(child as Element, element, visited)) {
                if (cached) { cached.set(element, true); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
                return true;
              }
            }
          }
        }
        if (cached) { cached.set(element, false); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
        return false;
      } else if (item.localName === 'group') {
        if (!visited.has(item)) {
          visited.add(item);
          // Check if the group contains the element (resolve ref or definition)
          const groupName = item.getAttribute('ref');
          const grp = groupName ? this.schemaIndex.groups[groupName] : item;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model) {
              const res = this.itemContainsElement(model, element, visited);
              if (cached) { cached.set(element, res); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
              return res;
            }
          }
        }
      }
      if (cached) { cached.set(element, false); if (this.shouldProfileCaches) this.cacheStats.containsCache.sets++; }
      return false;
    } finally {
      if (__profiling) this.profEnd('itemContainsElement', __t0);
    }
  }

  /**
   * Find a nested sequence within a choice that contains the specified element
   */
  private findNestedSequenceContainingElement(root: Element, elementItem: Element): Element | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const stack: Element[] = [root];
      const visited = new Set<Element>();
      let steps = 0;
      const MAX_STEPS = 20000; // hard safety cap to avoid runaway traversals
      while (stack.length) {
        if (++steps > MAX_STEPS) break;
        const node = stack.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);

        // If this is a group, resolve to its model and traverse that instead of raw children
        if (node.localName === 'group') {
          const ref = node.getAttribute('ref');
          const grp = ref ? this.schemaIndex.groups[ref] : node;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model) {
              // If resolved model is a sequence that contains the element, return it
              if (model.localName === 'sequence' && this.itemContainsElement(model, elementItem)) {
                return model;
              }
              // Otherwise, continue traversal within the resolved model
              if (!visited.has(model)) stack.push(model);
              continue;
            }
          }
        }

        // Direct sequence detection
        if (node.localName === 'sequence' && this.itemContainsElement(node, elementItem)) {
          return node;
        }

        // Traverse children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            const el = child as Element;
            if (!visited.has(el)) stack.push(el);
          }
        }
      }
      return null;
    } finally {
      if (__profiling) this.profEnd('findNestedSequenceContainingElement', __t0);
    }
  }

  /**
   * Check if a choice contains the specified element
   * @param choice The choice element
   * @param elementItem The element name to look for
   * @returns True if the choice contains the element
   */
  private choiceContainsElement(choice: Element, elementItem: Element, visited?: Set<Element>): boolean {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Initialize visited set for cycle detection across recursive traversals
      if (!visited) visited = new Set<Element>();
      if (visited.has(choice)) return false;
      visited.add(choice);

      for (let i = 0; i < choice.childNodes.length; i++) {
        const child = choice.childNodes[i];
        if (child.nodeType === 1) {
          const element = child as Element;

          if (element.localName === 'element' && element === elementItem) {
            return true;
          } else if (element.localName === 'choice') {
            if (this.choiceContainsElement(element, elementItem, visited)) {
              return true;
            }
          } else if (element.localName === 'sequence') {
            // A sequence can be an alternative in a choice (e.g., do_if/do_elseif/do_else)
            // Delegate to generic itemContainsElement to search within the sequence
            if (this.itemContainsElement(element, elementItem, visited)) {
              return true;
            }
          } else if (element.localName === 'group') {
            const groupName = element.getAttribute('ref');
            const grp = groupName ? this.schemaIndex.groups[groupName] : element;
            if (grp) {
              const model = this.findDirectContentModel(grp);
              if (model && this.itemContainsElement(model, elementItem, visited)) {
                return true;
              }
            }
          }
        }
      }

      return false;
    } finally {
      if (__profiling) this.profEnd('choiceContainsElement', __t0);
    }
  }

  /**
   * Get elements from a sequence item (element, choice, group)
   * @param item The sequence item
   * @param allChildren All possible child elements for reference
   * @returns Array of elements from the item
   */
  private getElementsFromSequenceItem(item: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (item.localName === 'element') {
        if (item.hasAttribute('name')) {
          const element = allChildren.find(elem => elem === item);
          return element ? [element] : [];
        }
      } else if (item.localName === 'choice') {
        return this.getElementsInChoice(item, allChildren);
      } else if (item.localName === 'sequence') {
        // When asked generically, return only the start-capable elements of this sequence
        return this.getStartElementsOfSequence(item, allChildren);
      } else if (item.localName === 'group') {
        const groupName = item.getAttribute('ref');
        const grp = groupName ? this.schemaIndex.groups[groupName] : item;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) {
            if (model.localName === 'choice') {
              return this.getElementsInChoice(model, allChildren);
            } else if (model.localName === 'sequence') {
              return this.getStartElementsOfSequence(model, allChildren);
            } else if (model.localName === 'all') {
              const results: Element[] = [];
              for (let j = 0; j < model.childNodes.length; j++) {
                const allChild = model.childNodes[j];
                if (allChild.nodeType === 1) {
                  results.push(...this.getStartElementsFromItem(allChild as Element, allChildren));
                }
              }
              return results;
            }
          }
        }
      }

      return [];
    } finally {
      if (__profiling) this.profEnd('getElementsFromSequenceItem', __t0);
    }
  }

  /**
   * Get all elements within a choice
   * @param choice The choice element
   * @param allChildren All possible child elements for reference
   * @returns Array of elements that are options in the choice
   */
  private getElementsInChoice(choice: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const choiceElements: Element[] = [];

      for (let i = 0; i < choice.childNodes.length; i++) {
        const child = choice.childNodes[i];
        if (child.nodeType === 1) {
          const element = child as Element;

          if (element.localName === 'element') {
            if (element.hasAttribute('name')) {
              const foundElement = allChildren.find(elem => elem === element);
              if (foundElement) {
                choiceElements.push(foundElement);
              }
            }
          } else if (element.localName === 'choice') {
            // Nested choice: include only its start-capable options
            choiceElements.push(...this.getElementsInChoice(element, allChildren));
          } else if (element.localName === 'sequence') {
            // Sequence within choice: only include elements that can start that sequence (not follow-up-only items)
            choiceElements.push(...this.getStartElementsOfSequence(element, allChildren));
          } else if (element.localName === 'group') {
            // Resolve group (ref or definition) to its direct content model and include start-capable options
            const groupName = element.getAttribute('ref');
            const grp = groupName ? this.schemaIndex.groups[groupName] : element;
            if (grp) {
              const model = this.findDirectContentModel(grp);
              if (model) {
                if (model.localName === 'choice') {
                  choiceElements.push(...this.getElementsInChoice(model, allChildren));
                } else if (model.localName === 'sequence') {
                  choiceElements.push(...this.getStartElementsOfSequence(model, allChildren));
                } else if (model.localName === 'all') {
                  for (let j = 0; j < model.childNodes.length; j++) {
                    const allChild = model.childNodes[j];
                    if (allChild.nodeType === 1) {
                      choiceElements.push(...this.getStartElementsFromItem(allChild as Element, allChildren));
                    }
                  }
                }
              }
            }
          }
        }
      }

      return choiceElements;
    } finally {
      if (__profiling) this.profEnd('getElementsInChoice', __t0);
    }
  }

  /**
   * Get the set of elements that can legally start the provided sequence, honoring minOccurs on leading items.
   */
  private getStartElementsOfSequence(seq: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      const results: Element[] = [];
      for (let i = 0; i < seq.childNodes.length; i++) {
        const child = seq.childNodes[i];
        if (child.nodeType !== 1) continue;
        const item = child as Element;
        // Include start elements of this item
        const startElems = this.getStartElementsFromItem(item, allChildren);
        results.push(...startElems);
        // Stop if this item is required; otherwise, continue to next optional item
        const minOccurs = this.getEffectiveMinOccurs(item, seq);
        if (minOccurs >= 1) break;
      }
      // De-duplicate preserving order
      const seen = new Set<string>();
      return results.filter(e => {
        const name = e.getAttribute('name') || '';
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
    } finally {
      if (__profiling) this.profEnd('getStartElementsOfSequence', __t0);
    }
  }

  /**
   * Return the elements that can appear at the start position of a sequence item.
   */
  private getStartElementsFromItem(item: Element, allChildren: Element[]): Element[] {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      if (item.localName === 'element') {
        if (item.hasAttribute('name')) {
          const foundElement = allChildren.find(elem => elem === item);
          return foundElement ? [foundElement] : [];
        }
        return [];
      } else if (item.localName === 'choice') {
        return this.getElementsInChoice(item, allChildren);
      } else if (item.localName === 'sequence') {
        return this.getStartElementsOfSequence(item, allChildren);
      } else if (item.localName === 'group') {
        // Resolve group (ref or definition) to its direct content model
        const groupName = item.getAttribute('ref');
        const grp = groupName ? this.schemaIndex.groups[groupName] : item;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) {
            if (model.localName === 'choice') {
              return this.getElementsInChoice(model, allChildren);
            } else if (model.localName === 'sequence') {
              return this.getStartElementsOfSequence(model, allChildren);
            } else if (model.localName === 'all') {
              const results: Element[] = [];
              for (let j = 0; j < model.childNodes.length; j++) {
                const allChild = model.childNodes[j];
                if (allChild.nodeType === 1) {
                  results.push(...this.getStartElementsFromItem(allChild as Element, allChildren));
                }
              }
              return results;
            }
          }
        }
        return [];
      }
      return [];
    } finally {
      if (__profiling) this.profEnd('getStartElementsFromItem', __t0);
    }
  }

  /**
   * Compute effective minOccurs for a sequence child item, propagating from the enclosing sequence if undefined.
   */
  private getEffectiveMinOccurs(item: Element, parentSequence?: Element): number {
    const raw = item.getAttribute('minOccurs');
    if (raw !== null && raw !== '') {
      const v = parseInt(raw);
      return isNaN(v) ? 1 : v;
    }
    if (parentSequence) {
      const seqRaw = parentSequence.getAttribute('minOccurs');
      if (seqRaw !== null && seqRaw !== '') {
        const sv = parseInt(seqRaw);
        return isNaN(sv) ? 1 : sv;
      }
    }
    return 1;
  }

  /**
   * Compute effective maxOccurs for a sequence child item, propagating from the enclosing sequence if undefined.
   */
  private getEffectiveMaxOccurs(item: Element, parentSequence?: Element): number | 'unbounded' {
    const raw = item.getAttribute('maxOccurs');
    if (raw !== null && raw !== '') {
      return raw === 'unbounded' ? 'unbounded' : (isNaN(parseInt(raw)) ? 1 : parseInt(raw));
    }
    if (parentSequence) {
      const seqRaw = parentSequence.getAttribute('maxOccurs');
      if (seqRaw !== null && seqRaw !== '') {
        return seqRaw === 'unbounded' ? 'unbounded' : (isNaN(parseInt(seqRaw)) ? 1 : parseInt(seqRaw));
      }
    }
    return 1;
  }

  /**
   * Check if a type name is a built-in XSD type
   * @param typeName The type name to check
   * @returns True if it's a built-in type
   */
  private isBuiltInXsdType(typeName: string): boolean {
    const localName = typeName.includes(':') ? typeName.split(':')[1] : typeName;
    return Schema.builtInTypes.has(localName);
  }

  /**
   * Get enumeration values for a named SimpleType
   * @param simpleTypeName The name of the SimpleType to get enumeration values from
   * @returns Object containing enumeration values and their annotations, or null if not found or not an enumeration
   */
  public getSimpleTypeEnumerationValues(simpleTypeName: string): {
    values: string[],
    annotations: Map<string, string>
  } | null {
    const __profiling = this.shouldProfileMethods;
    const __t0 = __profiling ? this.profStart() : 0;
    try {
      // Look up the type in the schema index
      const typeNode = this.schemaIndex.types[simpleTypeName];
      if (!typeNode) {
        return null; // Type not found
      }

      // Check if this is a simpleType
      if (typeNode.localName !== 'simpleType') {
        return null; // Not a simple type
      }

      // Extract enumeration values from the simple type, including union member types
      const allEnumValues: string[] = [];
      const allAnnotations = new Map<string, string>();

      // First, try to extract direct enumeration values
      const validationInfo: Partial<EnhancedAttributeInfo> = this.getCachedValidationInfo(typeNode);

      if (validationInfo.enumValues && validationInfo.enumValues.length > 0) {
        allEnumValues.push(...validationInfo.enumValues);
        const directAnnotations = this.extractEnumValueAnnotations(typeNode);
        for (const [key, value] of directAnnotations) {
          allAnnotations.set(key, value);
        }
      }

      // Check for union types and extract enumeration values from member types
      const unions = this.findChildElements(typeNode, 'union');
      for (const union of unions) {
        const memberTypes = union.getAttribute('memberTypes');
        if (memberTypes) {
          const typeNames = memberTypes.trim().split(/\s+/);
          for (const memberTypeName of typeNames) {
            if (memberTypeName) {
              // Recursively get enumeration values from member types
              const memberEnumResult = this.getSimpleTypeEnumerationValues(memberTypeName);
              if (memberEnumResult) {
                // Add unique values only
                for (const value of memberEnumResult.values) {
                  if (!allEnumValues.includes(value)) {
                    allEnumValues.push(value);
                  }
                }
                // Add annotations
                for (const [key, value] of memberEnumResult.annotations) {
                  allAnnotations.set(key, value);
                }
              }
            }
          }
        }
      }

      // Check if we found any enumeration values
      if (allEnumValues.length === 0) {
        return null; // No enumeration values found
      }

      return {
        values: allEnumValues,
        annotations: allAnnotations
      };
    } finally {
      if (__profiling) {
        this.profEnd('getSimpleTypeEnumerationValues', __t0);
      }
    }
  }

  /**
   * Clear all caches and resources
   */
  public dispose(): void {
    this.printCacheStats();
    this.printMethodStats();
    this.initializeCaches();
  }
}
