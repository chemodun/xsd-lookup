import * as fs from 'fs';
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
  hierarchyLookups: Map<string, Element | null>;
  definitionReachability: Map<string, boolean>;
  elementSearchResults: Map<string, Element[]>;
  attributeCache: Map<string, AttributeInfo[]>;
  hierarchyValidation: Map<string, boolean>;
  elementDefinitionCache: Map<string, Element | undefined>; // New cache for getElementDefinition
}

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
  private schemaIndex: SchemaIndex;
  private elementMap: Record<string, ElementMapEntry[]>;
  private elementContexts: Record<string, ElementContext[]>;
  private cache!: HierarchyCache;
  private maxCacheSize: number = 10000;
  constructor(xsdFilePath: string, includeFiles: string[] = []) {
    // Initialize caches and metrics first
    this.initializeCaches();

    this.doc = this.loadXml(xsdFilePath);

    // Merge include files if any
    for (const includeFile of includeFiles) {
      const includeDoc = this.loadXml(includeFile);
      this.mergeXsds(this.doc, includeDoc);
    }

    // Build indexes
    this.schemaIndex = this.indexSchema(this.doc.documentElement as any);
    this.elementMap = this.buildElementMap();
    this.elementContexts = this.schemaIndex.elementContexts;
  }

  /**
   * Initialize all cache structures with empty maps
   */
  private initializeCaches(): void {
    this.cache = {
      hierarchyLookups: new Map(),
      definitionReachability: new Map(),
      elementSearchResults: new Map(),
      attributeCache: new Map(),
      hierarchyValidation: new Map(),
      elementDefinitionCache: new Map()
    };
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
    if (this.cache.hierarchyLookups.size > this.maxCacheSize) {
      // Simple LRU: clear oldest half
      const entries = Array.from(this.cache.hierarchyLookups.entries());
      const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
      this.cache.hierarchyLookups.clear();
      toKeep.forEach(([key, value]) => this.cache.hierarchyLookups.set(key, value));
    }

    // Apply same logic to other caches
    if (this.cache.definitionReachability.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.definitionReachability.entries());
      const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
      this.cache.definitionReachability.clear();
      toKeep.forEach(([key, value]) => this.cache.definitionReachability.set(key, value));
    }

    if (this.cache.elementSearchResults.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.elementSearchResults.entries());
      const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
      this.cache.elementSearchResults.clear();
      toKeep.forEach(([key, value]) => this.cache.elementSearchResults.set(key, value));
    }

    if (this.cache.attributeCache.size > this.maxCacheSize) {      const entries = Array.from(this.cache.attributeCache.entries());
      const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
      this.cache.attributeCache.clear();
      toKeep.forEach(([key, value]) => this.cache.attributeCache.set(key, value));
    }

    if (this.cache.elementDefinitionCache.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.elementDefinitionCache.entries());
      const toKeep = entries.slice(-Math.floor(this.maxCacheSize / 2));
      this.cache.elementDefinitionCache.clear();
      toKeep.forEach(([key, value]) => this.cache.elementDefinitionCache.set(key, value));
    }
  }


  /**
   * Load and parse an XML file into a DOM Document
   * @param filePath The path to the XML file to load
   * @returns Parsed DOM Document
   */
  private loadXml(filePath: string): Document {
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
    }

  /**
   * Merge included XSD documents into the main schema document
   * @param mainDoc The main schema document to merge into
   * @param includeDoc The included schema document to merge from
   */
  private mergeXsds(mainDoc: Document, includeDoc: Document): void {
    const mainSchema = mainDoc.documentElement;
    const includeSchema = includeDoc.documentElement;
    for (let i = 0; i < includeSchema.childNodes.length; i++) {
      const node = includeSchema.childNodes[i];
      if (node.nodeType === 1) {
        mainSchema.appendChild(node.cloneNode(true));
      }
    }
  }
  /**
   * Recursively collect all element definitions from the schema DOM
   * @param node The current node to examine
   * @param parentName The name of the parent element
   * @param elements Array to collect found elements into
   * @param ns The XML Schema namespace prefix
   * @returns Array of collected elements with their parent information
   */
  private collectElements(node: Node, parentName: string | null, elements: ElementWithParent[] = [], ns: string = 'xs:'): ElementWithParent[] {
    if (!node) return elements;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.nodeName === ns + 'element' && element.getAttribute('name')) {
        elements.push({
          name: element.getAttribute('name')!,
          parent: parentName,
          node: element
        });
      }
      // Recurse into children
      for (let i = 0; i < element.childNodes.length; i++) {
        this.collectElements(element.childNodes[i], element.getAttribute('name') || parentName, elements, ns);
      }
    }
    return elements;
  }
  /**
   * Build a map of element names to their definitions and parent relationships
   * @returns Record mapping element names to arrays of their definitions
   */
  private buildElementMap(): Record<string, ElementMapEntry[]> {
    const elements = this.collectElements(this.doc.documentElement, null);
    const elementMap: Record<string, ElementMapEntry[]> = {};
    elements.forEach(e => {
      if (!elementMap[e.name]) elementMap[e.name] = [];
      elementMap[e.name].push({ parent: e.parent, node: e.node });
    });
    return elementMap;
  }
  /**
   * Index the schema by collecting all global elements, groups, attribute groups, and types
   * @param root The root schema element
   * @param ns The XML Schema namespace prefix
   * @returns Complete schema index with all definitions and contexts
   */
  private indexSchema(root: Element, ns: string = 'xs:'): SchemaIndex {
    const elements: Record<string, Element[]> = {};  // Changed to arrays
    const groups: Record<string, Element> = {};
    const attributeGroups: Record<string, Element> = {};
    const types: Record<string, Element> = {};

    // First, collect only direct children of the schema root (truly global elements)
    for (let i = 0; i < root.childNodes.length; i++) {
      const child = root.childNodes[i];
      if (child.nodeType === 1) {
        const element = child as Element;

        if (element.nodeName === ns + 'element' && element.getAttribute('name')) {
          const name = element.getAttribute('name')!;
          if (!elements[name]) elements[name] = [];
          elements[name].push(element);
        }
        else if (element.nodeName === ns + 'group' && element.getAttribute('name')) {
          groups[element.getAttribute('name')!] = element;
        }
        else if (element.nodeName === ns + 'attributeGroup' && element.getAttribute('name')) {
          attributeGroups[element.getAttribute('name')!] = element;
        }
        else if (element.nodeName === ns + 'complexType' && element.getAttribute('name')) {
          types[element.getAttribute('name')!] = element;
        }
        else if (element.nodeName === ns + 'simpleType' && element.getAttribute('name')) {
          types[element.getAttribute('name')!] = element;
        }
      }
    }

    // Then walk recursively to collect all types, groups, and attribute groups (which can be nested)
    const walkForTypesAndGroups = (node: Node): void => {
      if (!node || node.nodeType !== 1) return;
      const element = node as Element;

      // Only collect types and groups, not nested elements
      if (element.nodeName === ns + 'group' && element.getAttribute('name')) {
        groups[element.getAttribute('name')!] = element;
      }
      if (element.nodeName === ns + 'attributeGroup' && element.getAttribute('name')) {
        attributeGroups[element.getAttribute('name')!] = element;
      }
      if (element.nodeName === ns + 'complexType' && element.getAttribute('name')) {
        types[element.getAttribute('name')!] = element;
      }
      if (element.nodeName === ns + 'simpleType' && element.getAttribute('name')) {
        types[element.getAttribute('name')!] = element;
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
  }

  /**
   * Build comprehensive element contexts, including elements reachable through groups
   */
  private buildElementContexts(
    globalElements: Record<string, Element[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>
  ): Record<string, ElementContext[]> {
    const elementContexts: Record<string, ElementContext[]> = {};
    const ns = 'xs:';

    // Build type-to-element mapping
    const typeToElements = this.buildTypeToElementMapping(globalElements, types);

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
      this.extractElementsFromGroup(groupElement, groupName, elementContexts, groups, types, ns);
    }

    // IMPORTANT: Also traverse all global elements to find inline element definitions
    // This captures cases like param under params, where param is defined inline
    // AND handles type references in context (e.g., library element using interrupt_library type)
    for (const [elementName, elements] of Object.entries(globalElements)) {
      for (const element of elements) {
        this.extractInlineElementsFromElement(element, elementName, elementContexts, groups, types, ns, [elementName]);
      }
    }

    return elementContexts;
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
    ns: string,
    visitedGroups: Set<string> = new Set()
  ): void {
    // Prevent infinite recursion in group references
    if (visitedGroups.has(groupName)) return;
    visitedGroups.add(groupName);

    const extractElements = (node: Element, currentGroups: string[]): void => {
      if (!node || node.nodeType !== 1) return;

      // If this is an element definition, add it to contexts
      if (node.nodeName === ns + 'element' && node.getAttribute('name')) {
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
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refGroupName = node.getAttribute('ref')!;
        const refGroup = groups[refGroupName];
        if (refGroup && !visitedGroups.has(refGroupName)) {
          this.extractElementsFromGroup(refGroup, refGroupName, elementContexts, groups, types, ns, new Set(visitedGroups));
        }
      }

      // Handle type extensions - extract elements from the base type
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = types[baseName];
        if (baseType) {
          // Extract elements from the base type within the current element's context
          // For group elements, we need to find the parent element
          let parentElement = node.parentNode;
          while (parentElement && parentElement.nodeType === 1) {
            const parentElem = parentElement as Element;
            if (parentElem.nodeName === ns + 'element') {
              const parentElementName = parentElem.getAttribute('name');
              if (parentElementName) {
                // Extract elements from the base type with the parent element as context
                this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, ns, new Set(), [parentElementName]);
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
    ns: string,
    parentContext: string[],
    visitedGroups: Set<string> = new Set()
  ): void {
    // Prevent infinite recursion
    if (visitedGroups.has(groupName)) return;
    visitedGroups.add(groupName);

    const extractElements = (node: Element): void => {
      if (!node || node.nodeType !== 1) return;

      // If this is an element definition, add it to contexts with group and parent info
      if (node.nodeName === ns + 'element' && node.getAttribute('name')) {
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
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refGroupName = node.getAttribute('ref')!;
        const refGroup = groups[refGroupName];
        if (refGroup && !visitedGroups.has(refGroupName)) {
          this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, ns, parentContext, new Set(visitedGroups));
        }
      }

      // Handle type extensions - extract elements from the base type
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = types[baseName];
        if (baseType) {
          // Extract elements from the base type within the current element's context
          // For group elements with parent context, we need to find the parent element
          let parentElement = node.parentNode;
          while (parentElement && parentElement.nodeType === 1) {
            const parentElem = parentElement as Element;
            if (parentElem.nodeName === ns + 'element') {
              const parentElementName = parentElem.getAttribute('name');
              if (parentElementName) {
                // Extract elements from the base type with the parent element as context
                this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, ns, new Set(), [parentElementName, ...parentContext]);
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
    ns: string,
    visitedTypes: Set<string> = new Set(),
    parentElementNames: string[] = []
  ): void {
    // Prevent infinite recursion in type references
    if (visitedTypes.has(typeName)) return;
    visitedTypes.add(typeName);

    // Use the provided parent element names instead of the type name
    const currentParents = parentElementNames.length > 0 ? parentElementNames : [typeName];

    const extractElements = (node: Element, currentParents: string[]): void => {
      if (!node || node.nodeType !== 1) return;

      // If this is an element definition, add it to contexts
      if (node.nodeName === ns + 'element' && node.getAttribute('name')) {
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
            this.extractElementsFromType(types[typeAttr], typeAttr, elementContexts, groups, types, ns, new Set(), [elementName, ...currentParents]);
          }
        }
      }

      // If this is a group reference, extract elements from the group and mark with group membership
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refGroupName = node.getAttribute('ref')!;
        const refGroup = groups[refGroupName];
        if (refGroup) {
          // Extract elements from the group and mark them with group membership
          // Only pass the immediate parent, not the full chain
          const immediateParent = currentParents.length > 0 ? [currentParents[0]] : [];
          this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, ns, immediateParent);
        }
      }

      // Handle type extensions - extract elements from the base type
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = types[baseName];
        if (baseType && !visitedTypes.has(baseName)) {
          // Extract elements from the base type with the same parent context
          this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, ns, new Set([...visitedTypes, baseName]), currentParents);
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
  }

  /**
   * Extract inline elements from a global element definition
   * This captures elements like param under params that are defined inline
   */
  private extractInlineElementsFromElement(
    parentElement: Element,
    parentElementName: string,
    elementContexts: Record<string, ElementContext[]>,
    groups: Record<string, Element>,
    types: Record<string, Element>,
    ns: string,
    initialParents: string[] = []
  ): void {
    const extractInlineElements = (node: Element, currentParents: string[], isRootElement: boolean = false): void => {
      if (!node || node.nodeType !== 1) return;

      // If this is an inline element definition, add it to contexts
      if (node.nodeName === ns + 'element' && node.getAttribute('name')) {
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
          this.extractElementsFromType(types[typeAttr], typeAttr, elementContexts, groups, types, ns, new Set(), [elementName]);
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
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refGroupName = node.getAttribute('ref')!;
        const refGroup = groups[refGroupName];
        if (refGroup) {
          this.extractElementsFromGroupWithParentContext(refGroup, refGroupName, elementContexts, groups, types, ns, currentParents);
        }
      }

      // Handle type extensions - extract elements from the base type
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = types[baseName];
        if (baseType) {
          // Extract elements from the base type with the same parent context
          this.extractElementsFromType(baseType, baseName, elementContexts, groups, types, ns, new Set(), currentParents);
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
  }

  public getElementDefinition(elementName: string, hierarchy: string[] = []): Element | undefined {
    // Create cache key from element name and hierarchy
    const hierarchyKey = hierarchy.length > 0 ? hierarchy.join('|') : '';
    const fullCacheKey = `${elementName}::${hierarchyKey}`;

    // Check if we have an exact match in cache
    if (this.cache.elementDefinitionCache.has(fullCacheKey)) {
      return this.cache.elementDefinitionCache.get(fullCacheKey);
    }

    // Check for partial matches in cache - look for any cached key that starts with our element name
    // and has a hierarchy that our current hierarchy extends
    if (hierarchy.length > 0) {
      for (const [cachedKey, cachedElement] of this.cache.elementDefinitionCache) {
        if (cachedKey.startsWith(`${elementName}::`)) {
          // Extract the cached hierarchy
          const cachedHierarchyStr = cachedKey.substring(`${elementName}::`.length);
          if (cachedHierarchyStr === '') continue; // Skip global element cache entries

          const cachedHierarchy = cachedHierarchyStr.split('|');

          // Check if the current hierarchy starts with the cached hierarchy
          // If cached: [parent, grandparent] and current: [parent, grandparent, great-grandparent]
          // then we can use the cached result since it's a more specific match
          if (cachedHierarchy.length <= hierarchy.length) {
            let isMatch = true;
            for (let i = 0; i < cachedHierarchy.length; i++) {
              if (cachedHierarchy[i] !== hierarchy[i]) {
                isMatch = false;
                break;
              }
            }

            if (isMatch && cachedElement) {
              // Found a matching cached result for a shorter hierarchy

              // Cache this result for the current full hierarchy too
              this.cache.elementDefinitionCache.set(fullCacheKey, cachedElement);
              this.ensureCacheSize();

              return cachedElement;
            }
          }
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

          break; // Exit the loop since we found a match
        }
      }
    }

    // Cache the final result (even if undefined)
    this.cache.elementDefinitionCache.set(fullCacheKey, result);
    this.ensureCacheSize();

    return result;
  }

  /**
   * Get global element definitions by name (direct children of schema root only)
   * @param elementName The name of the element to find
   * @returns Array of global element definitions
   */
  private getGlobalElementDefinitions(elementName: string): Element[] {
    // Only return truly global elements (direct children of schema root)
    if (this.schemaIndex.elements[elementName]) {
      return this.schemaIndex.elements[elementName];
    }

    // Do NOT fall back to elementMap as it contains nested elements too
    return [];
  }

  /**
   * Get global element or type definitions by name for hierarchical search
   * @param name The name to search for
   * @returns Array of element or type definitions matching the name
   */
    private getGlobalElementOrTypeDefs(name: string): Element[] {
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
  }

  /**
   * Find element definitions within a parent definition by element name
   * @param parentDef The parent element or type definition to search in
   * @param elementName The name of the element to find
   * @returns Array of matching element definitions
   */
  private findElementsInDefinition(parentDef: Element, elementName: string): Element[] {
    if (!parentDef) return [];

    const ns = 'xs:';
    const results: Element[] = [];
    let maxSearchDepth = 0;

    // Get the actual type definition to search in
    let typeNode = parentDef;

    // If parentDef is an element, get its type
    if (parentDef.nodeName === ns + 'element') {
      const typeName = parentDef.getAttribute('type');
      if (typeName && this.schemaIndex.types[typeName]) {
        typeNode = this.schemaIndex.types[typeName];
      } else {
        // Look for inline complexType
        for (let i = 0; i < parentDef.childNodes.length; i++) {
          const child = parentDef.childNodes[i];
          if (child.nodeType === 1 && (child as Element).nodeName === ns + 'complexType') {
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
      if (node.nodeName === ns + 'element' && node.getAttribute('name') === elementName) {
        results.push(node);
        return; // Don't recurse into found elements - early exit optimization
      }

      // Early exit optimization: if we've found enough results, stop searching
      if (results.length >= 3) return;

      // Handle type references and extensions
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = this.schemaIndex.types[baseName];
        if (baseType) {
          searchInNode(baseType, depth + 1);
        }
      }

      // Handle group references
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refName = node.getAttribute('ref')!;
        const groupDef = this.schemaIndex.groups[refName];
        if (groupDef) {
          searchInNode(groupDef, depth + 1);
        }
      }

      // Handle structural elements - recurse into ALL children
      if (node.nodeName === ns + 'sequence' ||
          node.nodeName === ns + 'choice' ||
          node.nodeName === ns + 'all' ||
          node.nodeName === ns + 'complexType' ||
          node.nodeName === ns + 'complexContent' ||
          node.nodeName === ns + 'simpleContent' ||
          node.nodeName === ns + 'group') {

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

    return results;
  }

  /**
   * Find ALL immediate child elements within a parent definition (without filtering by name)
   * This is similar to findElementsInDefinition but returns all direct child elements
   * @param parentDef The parent element or type definition to search in
   * @returns Array of all immediate child element definitions
   */
  private findAllElementsInDefinition(parentDef: Element): Element[] {
    if (!parentDef) return [];

    const ns = 'xs:';
    const results: Element[] = [];

    // Get the actual type definition to search in
    let typeNode = parentDef;

    // If parentDef is an element, get its type
    if (parentDef.nodeName === ns + 'element') {
      const typeName = parentDef.getAttribute('type');
      if (typeName && this.schemaIndex.types[typeName]) {
        typeNode = this.schemaIndex.types[typeName];
      } else {
        // Look for inline complexType
        for (let i = 0; i < parentDef.childNodes.length; i++) {
          const child = parentDef.childNodes[i];
          if (child.nodeType === 1 && (child as Element).nodeName === ns + 'complexType') {
            typeNode = child as Element;
            break;
          }
        }
      }
    }

    // Search for IMMEDIATE child elements (limited depth for performance)
    const visited = new Set<Element>();

    const searchInNode = (node: Element, depth: number = 0): void => {
      if (!node || node.nodeType !== 1) return;

      // Depth limit for performance - prevent excessive recursion
      if (depth > 20) {
        return;
      }

      // Use the actual DOM node reference for cycle detection
      if (visited.has(node)) return;
      visited.add(node);

      // If this is an element definition, add it to results
      if (node.nodeName === ns + 'element' && node.getAttribute('name')) {
        results.push(node);
        return; // Don't recurse into found elements - we only want immediate children
      }

      // Handle type references and extensions
      if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
        const baseName = node.getAttribute('base')!;
        const baseType = this.schemaIndex.types[baseName];
        if (baseType) {
          searchInNode(baseType, depth + 1);
        }
      }

      // Handle group references
      if (node.nodeName === ns + 'group' && node.getAttribute('ref')) {
        const refName = node.getAttribute('ref')!;
        const groupDef = this.schemaIndex.groups[refName];
        if (groupDef) {
          searchInNode(groupDef, depth + 1);
        }
      }

      // Handle structural elements - recurse into ALL children
      if (node.nodeName === ns + 'sequence' ||
          node.nodeName === ns + 'choice' ||
          node.nodeName === ns + 'all' ||
          node.nodeName === ns + 'complexType' ||
          node.nodeName === ns + 'complexContent' ||
          node.nodeName === ns + 'simpleContent' ||
          node.nodeName === ns + 'group') {

        // For structural nodes, recursively search all children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === 1) {
            searchInNode(child as Element, depth + 1);
          }
        }
      }
    };

    searchInNode(typeNode, 0);

    return results;
  }

  /**
   * Get enhanced attribute information including type and validation details
   */
  public getElementAttributes(elementName: string, hierarchy: string[] = []): AttributeInfo[] {
    // STRICT HIERARCHY RULE: If hierarchy provided, only search in hierarchy context
    // Never fall back to global elements when hierarchy is specified

    // If no hierarchy provided, only search global elements
    if (hierarchy.length === 0) {
      return this.getElementAttributesWithHierarchy(elementName, []);
    }

    // Step 1: Use progressive hierarchy search to find attributes
    // Stop as soon as we find any attributes at any depth
    // for (let contextDepth = 1; contextDepth <= hierarchy.length; contextDepth++) {
    //   // Take the first contextDepth elements (immediate context)
    //   const currentContext = hierarchy.slice(0, contextDepth);

      // const contextAttrs = this.getElementAttributesWithHierarchy(elementName, currentContext);
      const contextAttrs = this.getElementAttributesWithHierarchy(elementName, hierarchy);
      if (contextAttrs.length > 0) {
        // Found attributes at this depth - return them immediately
        return contextAttrs;
      }
    // }

    // No attributes found at any depth - do NOT fall back to global search
    return [];
  }

  /**
   * Get element attributes with hierarchy context for internal use
   * @param elementName The element name to get attributes for
   * @param hierarchy The element hierarchy in bottom-up order
   * @returns Array of attribute information
   */
  private getElementAttributesWithHierarchy(elementName: string, hierarchy: string[]): AttributeInfo[] {
    // Create cache key
    const cacheKey = `attrs:${elementName}:${hierarchy.join('>')}`;

    // Check cache first
    if (this.cache.attributeCache.has(cacheKey)) {
      return this.cache.attributeCache.get(cacheKey)!;
    }

    const attributes: Record<string, Element> = {};

    // Get the correct element definition based on hierarchical context
    const def = this.getElementDefinition(elementName, hierarchy);
    if (!def) {
      // Cache empty result
      const emptyResult: AttributeInfo[] = [];
      this.cache.attributeCache.set(cacheKey, emptyResult);
      this.ensureCacheSize();
      return emptyResult;
    }

    // Use the definition
    const bestDef = def;

    // Collect attributes from the element definition
    this.collectAttrs(bestDef, attributes);

    const result = Object.entries(attributes).map(([name, node]) => ({ name, node }));

    // Cache the result
    this.cache.attributeCache.set(cacheKey, result);
    this.ensureCacheSize();

    return result;
  }

  /**
   * Recursively collect attributes from element and type definitions
   * @param node The current node to collect attributes from
   * @param attributes Record to accumulate found attributes
   * @param visited Set to track visited nodes and prevent infinite recursion
   */
  private collectAttrs(node: Element, attributes: Record<string, Element>, visited: Set<string> = new Set()): void {
    if (!node || node.nodeType !== 1) return;

    const ns = 'xs:';

    // Use a unique key for types/groups to avoid infinite recursion
    let key: string | null = null;
    if (node.nodeName === ns + 'complexType' && node.getAttribute('name')) {
      key = 'type:' + node.getAttribute('name');
    } else if (node.nodeName === ns + 'group' && node.getAttribute('name')) {
      key = 'group:' + node.getAttribute('name');
    } else if (node.nodeName === ns + 'attributeGroup' && node.getAttribute('name')) {
      key = 'attrgroup:' + node.getAttribute('name');
    } else if (node.nodeName === ns + 'attributeGroup' && node.getAttribute('ref')) {
      key = 'attrgroupref:' + node.getAttribute('ref');
    }

    if (key && visited.has(key)) return;
    if (key) visited.add(key);

    // Handle different node types
    if (node.nodeName === ns + 'attribute') {
      const name = node.getAttribute('name');
      if (name) {
        attributes[name] = node;
      }
    } else if (node.nodeName === ns + 'attributeGroup' && node.getAttribute('ref')) {
      // Attribute group reference - resolve the reference
      const refName = node.getAttribute('ref')!;
      const group = this.schemaIndex.attributeGroups[refName];
      if (group) {
        this.collectAttrs(group, attributes, visited);
      }
    } else if (node.nodeName === ns + 'attributeGroup' && node.getAttribute('name')) {
      // Named attribute group definition - process its children
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          this.collectAttrs(child as Element, attributes, visited);
        }
      }
    } else if (node.nodeName === ns + 'extension' && node.getAttribute('base')) {
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
    } else if (node.nodeName === ns + 'complexContent' ||
               node.nodeName === ns + 'simpleContent') {
      // Content wrapper - process children
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          this.collectAttrs(child as Element, attributes, visited);
        }
      }
    } else if (node.nodeName === ns + 'complexType' ||
               node.nodeName === ns + 'sequence' ||
               node.nodeName === ns + 'choice' ||
               node.nodeName === ns + 'all') {
      // Structural nodes - traverse children but skip nested element definitions
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1 && (child as Element).nodeName !== ns + 'element') {
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
      if (child.nodeType === 1 && (child as Element).nodeName === ns + 'complexType') {
        this.collectAttrs(child as Element, attributes, visited);
        break;
      }
    }
  }
  /**
   * Get enhanced attribute information including type and validation details
   */
  public getElementAttributesWithTypes(elementName: string, hierarchy: string[] = []): EnhancedAttributeInfo[] {
    const attributes = this.getElementAttributes(elementName, hierarchy);

    // Enhance each attribute with type information
    return attributes.map(attr => {
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
  }

  /**
   * Get comprehensive validation information for a type
   */
  private getTypeValidationInfo(typeName: string): Partial<EnhancedAttributeInfo> {
    const typeNode = this.schemaIndex.types[typeName];
    if (!typeNode) return {};

    const validationInfo: Partial<EnhancedAttributeInfo> = {};
    const ns = 'xs:';

    const extractValidationRules = (node: Element): void => {
      if (!node || node.nodeType !== 1) return;

      // Use the reusable validation rule extraction
      this.extractValidationRulesFromNode(node, validationInfo);

      // Handle inheritance: if this is a restriction with a base type, inherit from base
      if (node.nodeName === ns + 'restriction') {
        const baseType = node.getAttribute('base');
        if (baseType && baseType !== 'xs:string' && baseType.indexOf(':') === -1) {
          // This is a user-defined base type, not a built-in XSD type
          const baseInfo = this.getTypeValidationInfo(baseType);
          // Merge base info into current info (current restrictions take precedence)
          Object.assign(validationInfo, baseInfo, validationInfo);
        }
      }

      // Handle union types: collect validation info from all member types
      if (node.nodeName === ns + 'union') {
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

    return validationInfo;
  }

  /**
   * Get validation information from inline type definitions (xs:simpleType within attribute)
   */
  private getInlineTypeValidationInfo(attributeNode: Element): Partial<EnhancedAttributeInfo> {
    const validationInfo: Partial<EnhancedAttributeInfo> = {};
    const ns = 'xs:';

    // Look for inline xs:simpleType definition within the attribute node
    for (let i = 0; i < attributeNode.childNodes.length; i++) {
      const child = attributeNode.childNodes[i];
      if (child.nodeType === 1 && (child as Element).nodeName === ns + 'simpleType') {
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

    return validationInfo;
  }

  /**
   * Extract validation rules from a node (reusable logic)
   */
  private extractValidationRulesFromNode(node: Element, validationInfo: Partial<EnhancedAttributeInfo>): void {
    if (!node || node.nodeType !== 1) return;

    const ns = 'xs:';

    // Extract enumeration values
    if (node.nodeName === ns + 'enumeration') {
      const value = node.getAttribute('value');
      if (value) {
        if (!validationInfo.enumValues) validationInfo.enumValues = [];
        validationInfo.enumValues.push(value);
      }
    }

    // Extract pattern restrictions
    if (node.nodeName === ns + 'pattern') {
      const pattern = node.getAttribute('value');
      if (pattern) {
        if (!validationInfo.patterns) validationInfo.patterns = [];
        validationInfo.patterns.push(pattern);
      }
    }

    // Extract length restrictions
    if (node.nodeName === ns + 'minLength') {
      const minLength = parseInt(node.getAttribute('value') || '0', 10);
      if (!isNaN(minLength)) {
        validationInfo.minLength = minLength;
      }
    }

    if (node.nodeName === ns + 'maxLength') {
      const maxLength = parseInt(node.getAttribute('value') || '0', 10);
      if (!isNaN(maxLength)) {
        validationInfo.maxLength = maxLength;
      }
    }

    // Extract numeric range restrictions
    if (node.nodeName === ns + 'minInclusive') {
      const minInclusive = parseFloat(node.getAttribute('value') || '0');
      if (!isNaN(minInclusive)) {
        validationInfo.minInclusive = minInclusive;
      }
    }

    if (node.nodeName === ns + 'maxInclusive') {
      const maxInclusive = parseFloat(node.getAttribute('value') || '0');
      if (!isNaN(maxInclusive)) {
        validationInfo.maxInclusive = maxInclusive;
      }
    }

    if (node.nodeName === ns + 'minExclusive') {
      const minExclusive = parseFloat(node.getAttribute('value') || '0');
      if (!isNaN(minExclusive)) {
        validationInfo.minExclusive = minExclusive;
      }
    }

    if (node.nodeName === ns + 'maxExclusive') {
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
  }

  /**
   * Validate an attribute value against its XSD definition
   */
  public validateAttributeValue(elementName: string, attributeName: string, attributeValue: string, hierarchy: string[] = []): AttributeValidationResult {
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
    // Normalize the value for validation (join multi-line content)
    const normalizedValue = this.normalizeAttributeValue(value);

    const restrictions: string[] = [];
    let isValid = true;
    let errorMessage: string | undefined;

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
    const numericTypes = [
      'xs:int', 'xs:integer', 'xs:long', 'xs:short', 'xs:byte',
      'xs:float', 'xs:double', 'xs:decimal',
      'xs:positiveInteger', 'xs:negativeInteger', 'xs:nonPositiveInteger', 'xs:nonNegativeInteger',
      'xs:unsignedInt', 'xs:unsignedLong', 'xs:unsignedShort', 'xs:unsignedByte'
    ];
    return numericTypes.includes(builtinType);
  }

  /**
   * Validate basic XSD types based on actual XSD definitions, not hardcoded assumptions
   */
  private validateBasicType(value: string, typeName: string): AttributeValidationResult {
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
  }

  /**
   * Resolve a type name to its ultimate built-in XSD type
   */
  private resolveToBuiltinType(typeName: string): string {
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
    const ns = 'xs:';
    const restrictions = this.findChildElements(typeNode, ns + 'restriction');

    if (restrictions.length > 0) {
      const baseType = restrictions[0].getAttribute('base');
      if (baseType) {
        // Recursively resolve the base type
        return this.resolveToBuiltinType(baseType);
      }
    }

    // Look for extension base
    const extensions = this.findChildElements(typeNode, ns + 'extension');
    if (extensions.length > 0) {
      const baseType = extensions[0].getAttribute('base');
      if (baseType) {
        // Recursively resolve the base type
        return this.resolveToBuiltinType(baseType);
      }
    }

    // Look for union types
    const unions = this.findChildElements(typeNode, ns + 'union');
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
  }

  /**
   * Helper method to find child elements by name
   */
  private findChildElements(parent: Element, elementName: string): Element[] {
    const results: Element[] = [];

    const searchInNode = (node: Element): void => {
      if (node.nodeName === elementName) {
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
  }

  /**
   * Validate against built-in XSD types only
   */
  private validateBuiltinXsdType(value: string, builtinType: string, originalType: string): AttributeValidationResult {
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
  }

  /**
   * Build a mapping from type names to element names that use those types
   */
  private buildTypeToElementMapping(
    globalElements: Record<string, Element[]>,
    types: Record<string, Element>
  ): Record<string, string[]> {
    const typeToElements: Record<string, string[]> = {};
    const ns = 'xs:';

    // Scan all global elements to find which types they use
    for (const [elementName, elements] of Object.entries(globalElements)) {
      for (const element of elements) {
        const typeAttr = element.getAttribute('type');
        if (typeAttr) {
          if (!typeToElements[typeAttr]) typeToElements[typeAttr] = [];
          if (!typeToElements[typeAttr].includes(elementName)) {
            typeToElements[typeAttr].push(elementName);
          }
        }

        // Also scan inline elements within this global element
        this.scanElementForInlineTypeReferences(element, typeToElements, ns);
      }
    }

    // Also scan type definitions for nested type references
    for (const [typeName, typeElement] of Object.entries(types)) {
      this.scanTypeForTypeReferences(typeElement, typeName, typeToElements, ns);
    }

    return typeToElements;
  }

  /**
   * Recursively scan a type element for type references
   * @param node The type element to scan
   * @param parentContext The parent type name for context
   * @param typeToElements Map to accumulate type-to-element mappings
   * @param ns The XML Schema namespace prefix
   */
  private scanTypeForTypeReferences(
    node: Element,
    parentContext: string,
    typeToElements: Record<string, string[]>,
    ns: string
  ): void {
    if (!node || node.nodeType !== 1) return;

    // Look for elements with type attributes
    if (node.nodeName === ns + 'element') {
      const typeAttr = node.getAttribute('type');
      if (typeAttr) {
        if (!typeToElements[typeAttr]) typeToElements[typeAttr] = [];
        if (!typeToElements[typeAttr].includes(parentContext)) {
          typeToElements[typeAttr].push(parentContext);
        }
      }
    }

    // Look for extension/restriction base attributes
    if ((node.nodeName === ns + 'extension' || node.nodeName === ns + 'restriction')) {
      const baseAttr = node.getAttribute('base');
      if (baseAttr) {
        if (!typeToElements[baseAttr]) typeToElements[baseAttr] = [];
        if (!typeToElements[baseAttr].includes(parentContext)) {
          typeToElements[baseAttr].push(parentContext);
        }
      }
    }

    // Recursively scan children
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === 1) {
        this.scanTypeForTypeReferences(child as Element, parentContext, typeToElements, ns);
      }
    }
  }

  /**
   * Recursively scan an element for inline elements that have type references
   * @param element The element to scan for inline type references
   * @param typeToElements Map to accumulate type-to-element mappings
   * @param ns The XML Schema namespace prefix
   */
  private scanElementForInlineTypeReferences(
    element: Element,
    typeToElements: Record<string, string[]>,
    ns: string
  ): void {
    if (!element || element.nodeType !== 1) return;

    // Look for inline element definitions
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];
      if (child.nodeType === 1) {
        const childElement = child as Element;

        // If this is an inline element with a type attribute
        if (childElement.nodeName === ns + 'element') {
          const elementName = childElement.getAttribute('name');
          const typeAttr = childElement.getAttribute('type');

          if (elementName && typeAttr) {
            if (!typeToElements[typeAttr]) typeToElements[typeAttr] = [];
            if (!typeToElements[typeAttr].includes(elementName)) {
              typeToElements[typeAttr].push(elementName);
            }
          }
        }

        // Recursively scan child elements
        this.scanElementForInlineTypeReferences(childElement, typeToElements, ns);
      }
    }
  }

  /**
   * Find element using top-down hierarchy search
   * @param elementName The element to find
   * @param topDownHierarchy Hierarchy from root to immediate parent [root, ..., immediate_parent]
   * @returns Element definition if found, undefined otherwise
   */
  private findElementTopDown(elementName: string, topDownHierarchy: string[]): Element | undefined {
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
    const ns = 'xs:';

    // Look for xs:annotation child element
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];
      if (child.nodeType === 1 && (child as Element).nodeName === ns + 'annotation') {
        const annotationElement = child as Element;

        // Look for xs:documentation within xs:annotation
        for (let j = 0; j < annotationElement.childNodes.length; j++) {
          const docChild = annotationElement.childNodes[j];
          if (docChild.nodeType === 1 && (docChild as Element).nodeName === ns + 'documentation') {
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
    const annotations = new Map<string, string>();
    const ns = 'xs:';

    const extractFromNode = (node: Element): void => {
      if (!node || node.nodeType !== 1) return;

      // Check if this is an enumeration element
      if (node.nodeName === ns + 'enumeration') {
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
  }

  /**
   * Get possible child elements for a given element by name and hierarchy
   * @param elementName The parent element name
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   * @param previousSibling Optional previous sibling element name to filter results based on sequence constraints
   * @returns Map where key is child element name and value is its annotation text
   */
  public getPossibleChildElements(elementName: string, hierarchy: string[] = [], previousSibling?: string): Map<string, string> {
    // Create cache key including previousSibling for proper caching
    const siblingKey = previousSibling ? `prev:${previousSibling}` : 'noprev';
    const cacheKey = `children:${elementName}:${hierarchy.join('>')}:${siblingKey}`;

    // Check if we have this in cache (reuse existing cache structure)
    if (this.cache.elementSearchResults.has(cacheKey)) {
      const cachedResult = this.cache.elementSearchResults.get(cacheKey);
      if (cachedResult) {
        const resultMap = new Map<string, string>();
        for (const elem of cachedResult) {
          const name = elem.getAttribute('name');
          const annotation = elem.getAttribute('data-annotation') || '';
          if (name) {
            resultMap.set(name, annotation);
          }
        }
        return resultMap;
      }
      return new Map<string, string>();
    }

    // Get the element definition using the same logic as other methods
    const elementDef = this.getElementDefinition(elementName, hierarchy);

    if (!elementDef) {
      // Cache empty result
      this.cache.elementSearchResults.set(cacheKey, []);
      this.ensureCacheSize();
      return new Map<string, string>();
    }

    // Get all possible child elements
    const childElements = this.findAllElementsInDefinition(elementDef);

    let filteredElements: Element[];

    // If previousSibling is provided, filter based on sequence/choice constraints
    if (previousSibling) {
      filteredElements = this.filterElementsBySequenceConstraints(elementDef, childElements, previousSibling);
    } else {
      // No previous sibling: honor the content model and only return start-capable elements
      const contentModel = this.findContentModel(elementDef);
      if (contentModel) {
        const modelType = contentModel.nodeName;
        if (modelType === 'xs:choice') {
          filteredElements = this.getElementsInChoice(contentModel, childElements);
        } else if (modelType === 'xs:sequence') {
          filteredElements = this.getStartElementsOfSequence(contentModel, childElements);
        } else if (modelType === 'xs:all') {
          // For xs:all, any element can start
          filteredElements = childElements;
        } else {
          filteredElements = childElements;
        }
      } else {
        filteredElements = childElements;
      }
    }

    const result = new Map<string, string>();

    // Build result map with annotations
    for (const element of filteredElements) {
      const name = element.getAttribute('name');
      if (name) {
        let annotation = Schema.extractAnnotationText(element);
        // If no direct annotation, try to get it from the element's type
        if (!annotation) {
          const typeName = element.getAttribute('type');
          if (typeName) {
            const typeDef = this.schemaIndex.types[typeName];
            if (typeDef) {
              annotation = Schema.extractAnnotationText(typeDef);
            }
          }
        }
        result.set(name, annotation || '');
      }
    }

    // Cache the result as Element array (for consistency with existing cache structure)
    const elementArray = Array.from(result.entries()).map(([name, annotation]) => {
      // Create a mock element for caching with annotation data
      const mockElem = this.doc.createElement('element');
      mockElem.setAttribute('name', name);
      mockElem.setAttribute('data-annotation', annotation);
      return mockElem;
    });
    this.cache.elementSearchResults.set(cacheKey, elementArray);
    this.ensureCacheSize();

    return result;
  }

  /**
   * Filter child elements based on XSD sequence constraints and previous sibling
   * @param elementDef The parent element definition
   * @param allChildren All possible child elements
   * @param previousSibling The name of the previous sibling element
   * @returns Filtered array of elements that are valid as next elements
   */
  private filterElementsBySequenceConstraints(elementDef: Element, allChildren: Element[], previousSibling: string): Element[] {
    // Find the content model (sequence/choice) within the element definition
    const contentModel = this.findContentModel(elementDef);

    if (!contentModel) {
      // If no content model found, return all children (fallback)
      return allChildren;
    }

    // Apply filtering based on content model type
    return this.getValidNextElementsInContentModel(contentModel, previousSibling, allChildren);
  }

  // Note: Sequence and choice handling is fully data-driven from the XSD; no element-name
  // special-casing is implemented here.

  /**
   * Find the content model (sequence/choice/all) within an element definition
   * @param elementDef The element definition to search
   * @returns The content model element, or null if not found
   */
  private findContentModel(elementDef: Element): Element | null {
    const ns = 'xs:';

    // If the node itself is already a content model, return it
    if (elementDef.nodeName === ns + 'sequence' || elementDef.nodeName === ns + 'choice' || elementDef.nodeName === ns + 'all') {
      return elementDef;
    }

    // If the node is a group (definition or ref), resolve to its direct content model
    if (elementDef.nodeName === ns + 'group') {
      const ref = elementDef.getAttribute('ref');
      const groupNode = ref ? this.schemaIndex.groups[ref] : elementDef;
      if (groupNode) {
        const direct = this.findDirectContentModel(groupNode);
        if (direct) return direct;
      }
    }

    // If this is a complexType or content extension/restriction, find direct content model
    if (elementDef.nodeName === ns + 'complexType' ||
        elementDef.nodeName === ns + 'complexContent' ||
        elementDef.nodeName === ns + 'simpleContent' ||
        elementDef.nodeName === ns + 'extension' ||
        elementDef.nodeName === ns + 'restriction') {
      const direct = this.findDirectContentModel(elementDef);
      if (direct) return direct;
    }

    // Look for complexType first
    for (let i = 0; i < elementDef.childNodes.length; i++) {
      const child = elementDef.childNodes[i];
      if (child.nodeType === 1 && (child as Element).nodeName === ns + 'complexType') {
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
  return this.findContentModel(typeDef);
      }
    }

    return null;
  }

  /**
   * Find direct content model in a complexType, extension, or restriction
   * @param parent The parent element to search in
   * @returns The content model element, or null if not found
   */
  private findDirectContentModel(parent: Element): Element | null {
    const ns = 'xs:';

    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i];
      if (child.nodeType === 1) {
        const element = child as Element;

        // Direct sequence/choice/all
        if (element.nodeName === ns + 'sequence' ||
            element.nodeName === ns + 'choice' ||
            element.nodeName === ns + 'all') {
          return element;
        }

        // Look in extension/restriction
        if (element.nodeName === ns + 'extension' || element.nodeName === ns + 'restriction') {
          const nested = this.findDirectContentModel(element);
          if (nested) {
            return nested;
          }
        }

        // Follow group references to find underlying content model
        if (element.nodeName === ns + 'group') {
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
  }

  /**
   * Get valid next elements based on content model and previous sibling
   * @param contentModel The sequence/choice/all element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Filtered elements that are valid as next elements
   */
  private getValidNextElementsInContentModel(contentModel: Element, previousSibling: string, allChildren: Element[]): Element[] {
    const modelType = contentModel.nodeName;

    if (modelType === 'xs:choice') {
      return this.getValidNextInChoice(contentModel, previousSibling, allChildren);
    } else if (modelType === 'xs:sequence') {
      return this.getValidNextInSequence(contentModel, previousSibling, allChildren);
    } else if (modelType === 'xs:all') {
      // For xs:all, any unused element can come next
      return allChildren; // Simplified - could be enhanced to track used elements
    }

    // Unknown model type, return all children
    return allChildren;
  }

  /**
   * Get valid next elements in a choice based on previous sibling
   * @param choice The choice element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Valid next elements
   */
  private getValidNextInChoice(choice: Element, previousSibling: string, allChildren: Element[]): Element[] {
    // If previousSibling belongs to a nested sequence option within this choice,
    // continue inside that same sequence arm and also allow restarting that arm (choice repetition).
    // IMPORTANT: Prefer scanning the direct alternatives of this choice first to avoid
    // accidentally picking outer sequences (e.g., the actions sequence) that contain the element indirectly.
    const ns = 'xs:';
    let nestedSeq: Element | null = null;
    for (let i = 0; i < choice.childNodes.length && !nestedSeq; i++) {
      const alt = choice.childNodes[i];
      if (alt.nodeType !== 1) continue;
      const el = alt as Element;
      if (el.nodeName === ns + 'sequence') {
        if (this.itemContainsElement(el, previousSibling)) {
          nestedSeq = el;
          break;
        }
      } else if (el.nodeName === ns + 'group') {
        const ref = el.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : el;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model && model.nodeName === ns + 'choice') {
            for (let j = 0; j < model.childNodes.length && !nestedSeq; j++) {
              const mchild = model.childNodes[j];
              if (mchild.nodeType !== 1) continue;
              const mEl = mchild as Element;
              if (mEl.nodeName === ns + 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                nestedSeq = mEl;
                break;
              }
            }
          } else if (model && model.nodeName === ns + 'sequence' && this.itemContainsElement(model, previousSibling)) {
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
      const ns = 'xs:';
      const items: { name: string; minOccurs: number; maxOccurs: number | 'unbounded' }[] = [];
      for (let i = 0; i < nestedSeq.childNodes.length; i++) {
        const child = nestedSeq.childNodes[i];
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (el.nodeName === ns + 'element') {
          const name = el.getAttribute('name');
          if (!name) continue;
          const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
          const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
          items.push({ name, minOccurs, maxOccurs });
        }
        // Note: nested structures inside the nested sequence are not expected in this arm
      }

      const allowed = new Set<string>();
      const prevIndex = items.findIndex(it => it.name === previousSibling);
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
  }

  /**
   * Get valid next elements in a sequence based on previous sibling
   * @param sequence The sequence element
   * @param previousSibling The name of the previous sibling
   * @param allChildren All possible child elements for reference
   * @returns Valid next elements in the sequence
   */
  private getValidNextInSequence(sequence: Element, previousSibling: string, allChildren: Element[], suppressFallback: boolean = false): Element[] {
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
    if (previousItem && previousItem.nodeName === 'xs:choice') {
      // Prefer direct alternative scan first
      const ns = 'xs:';
      let nestedSeq: Element | null = null;
      for (let i = 0; i < previousItem.childNodes.length && !nestedSeq; i++) {
        const alt = previousItem.childNodes[i];
        if (alt.nodeType !== 1) continue;
        const el = alt as Element;
        if (el.nodeName === ns + 'sequence') {
          if (this.itemContainsElement(el, previousSibling)) {
            nestedSeq = el;
            break;
          }
        } else if (el.nodeName === ns + 'group') {
          const ref = el.getAttribute('ref');
          const grp2 = ref ? this.schemaIndex.groups[ref] : el;
          if (grp2) {
            const model2 = this.findDirectContentModel(grp2);
            if (model2 && model2.nodeName === ns + 'choice') {
              for (let j = 0; j < model2.childNodes.length && !nestedSeq; j++) {
                const mchild = model2.childNodes[j];
                if (mchild.nodeType !== 1) continue;
                const mEl = mchild as Element;
                if (mEl.nodeName === ns + 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                  nestedSeq = mEl;
                  break;
                }
              }
            } else if (model2 && model2.nodeName === ns + 'sequence' && this.itemContainsElement(model2, previousSibling)) {
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
        const ns = 'xs:';
        const items: { name: string; minOccurs: number; maxOccurs: number | 'unbounded' }[] = [];
        for (let i = 0; i < nestedSeq.childNodes.length; i++) {
          const child = nestedSeq.childNodes[i];
          if (child.nodeType !== 1) continue;
          const el = child as Element;
          if (el.nodeName === ns + 'element') {
            const name = el.getAttribute('name');
            if (!name) continue;
            const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
            const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
            items.push({ name, minOccurs, maxOccurs });
          }
        }
        const allowedNames = new Set<string>();
        const prevIndex = items.findIndex(it => it.name === previousSibling);
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
    if (previousItem && previousItem.nodeName === 'xs:group') {
      const ns = 'xs:';
      const ref = previousItem.getAttribute('ref');
      const grp = ref ? this.schemaIndex.groups[ref] : previousItem;
      if (grp) {
        const model = this.findDirectContentModel(grp);
        if (model) {
          if (model.nodeName === ns + 'choice') {
            // Prefer direct alternative scan first inside the resolved choice
            let nestedSeq: Element | null = null;
            for (let i = 0; i < model.childNodes.length && !nestedSeq; i++) {
              const alt = model.childNodes[i];
              if (alt.nodeType !== 1) continue;
              const el = alt as Element;
              if (el.nodeName === ns + 'sequence') {
                if (this.itemContainsElement(el, previousSibling)) {
                  nestedSeq = el;
                  break;
                }
              } else if (el.nodeName === ns + 'group') {
                const ref = el.getAttribute('ref');
                const grp2 = ref ? this.schemaIndex.groups[ref] : el;
                if (grp2) {
                  const model2 = this.findDirectContentModel(grp2);
                  if (model2 && model2.nodeName === ns + 'choice') {
                    for (let j = 0; j < model2.childNodes.length && !nestedSeq; j++) {
                      const mchild = model2.childNodes[j];
                      if (mchild.nodeType !== 1) continue;
                      const mEl = mchild as Element;
                      if (mEl.nodeName === ns + 'sequence' && this.itemContainsElement(mEl, previousSibling)) {
                        nestedSeq = mEl;
                        break;
                      }
                    }
                  } else if (model2 && model2.nodeName === ns + 'sequence' && this.itemContainsElement(model2, previousSibling)) {
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
                if (el.nodeName === ns + 'element') {
                  const name = el.getAttribute('name');
                  if (!name) continue;
          const minOccurs = this.getEffectiveMinOccurs(el, nestedSeq);
          const maxOccurs = this.getEffectiveMaxOccurs(el, nestedSeq);
          items.push({ name, minOccurs, maxOccurs });
                }
              }
              const allowedNames = new Set<string>();
              const prevIndex = items.findIndex(it => it.name === previousSibling);
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
          } else if (model.nodeName === ns + 'sequence') {
            const seqNext = this.getValidNextInSequence(model, previousSibling, allChildren, true);
            validNext.push(...seqNext);
          } else if (model.nodeName === ns + 'all') {
            // xs:all has no ordering; allow allChildren
            validNext.push(...allChildren);
          }
        }
      }
    }

  // Note: do not override sibling computation by diving into the previous element's inner model here.

    // Check if the previous item can repeat
    if (previousItem && this.itemCanRepeat(previousItem, previousSibling)) {
      const ns = 'xs:';
      if (previousItem.nodeName === ns + 'choice') {
        // Repeating a choice: allow all alternatives that can start a new occurrence
        validNext.push(...this.getElementsInChoice(previousItem, allChildren));
      } else if (previousItem.nodeName === ns + 'group') {
        // Repeating a group: if it resolves to a choice, allow starting sequence alternatives only
        const ref = previousItem.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : previousItem;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model && model.nodeName === ns + 'choice') {
            // Allow all choice alternatives that can start a new occurrence
            validNext.push(...this.getElementsInChoice(model, allChildren));
          } else {
            // Fallback: repeat the same element
            const repeatElement = allChildren.find(elem => elem.getAttribute('name') === previousSibling);
            if (repeatElement) validNext.push(repeatElement);
          }
        }
      } else {
        // Element or other item repeats itself
        const repeatElement = allChildren.find(elem => elem.getAttribute('name') === previousSibling);
        if (repeatElement) validNext.push(repeatElement);
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

  // If all following items are optional (no required items encountered), then
    // after prioritizing these optional next items, allow any other elements
    // from the upper-level choice (i.e., allChildren minus those already suggested).
    let hasRequiredAfter = false;
    for (let i = previousPosition + 1; i < sequenceItems.length; i++) {
      const minOccurs = this.getEffectiveMinOccurs(sequenceItems[i], sequence);
      if (minOccurs >= 1) {
        hasRequiredAfter = true;
        break;
      }
    }

  // Do not fall back to other alternatives of the same choice here; that would allow do_elseif/do_else after unrelated items like do_all

    // When previous item is a choice, avoid leaking non-start elements of its sequence alternatives
    if (previousItem && previousItem.nodeName === 'xs:choice' && prevChoiceNonStart && prevChoiceNonStart.size > 0) {
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
  }

  /**
   * From the provided choice, return only the start-capable elements of sequence alternatives.
   * This matches the requirement that after a non-sequence sibling, only the sequence path (do_if...) may start.
   */
  private getSequenceStartElementsInChoice(choice: Element, allChildren: Element[]): Element[] {
    const ns = 'xs:';
    const result: Element[] = [];

    const collectFromNode = (node: Element) => {
      if (node.nodeName === ns + 'sequence') {
        result.push(...this.getStartElementsOfSequence(node, allChildren));
      } else if (node.nodeName === ns + 'group') {
        const ref = node.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : node;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) {
            if (model.nodeName === ns + 'sequence') {
              result.push(...this.getStartElementsOfSequence(model, allChildren));
            } else if (model.nodeName === ns + 'choice') {
              // Dive into nested choice to find sequence alternatives
              for (let k = 0; k < model.childNodes.length; k++) {
                const alt = model.childNodes[k];
                if (alt.nodeType === 1) {
                  collectFromNode(alt as Element);
                }
              }
            }
          }
        }
      } else if (node.nodeName === ns + 'choice') {
        // Dive into nested choice
        for (let k = 0; k < node.childNodes.length; k++) {
          const alt = node.childNodes[k];
          if (alt.nodeType === 1) {
            collectFromNode(alt as Element);
          }
        }
      }
      // Ignore direct element alternatives (e.g., do_all)
    };

    for (let i = 0; i < choice.childNodes.length; i++) {
      const child = choice.childNodes[i];
      if (child.nodeType !== 1) continue;
      collectFromNode(child as Element);
    }

    // Deduplicate preserving order
    const seen = new Set<string>();
    return result.filter(e => {
      const name = e.getAttribute('name') || '';
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }

  /**
   * Collect element names that are part of sequence alternatives in a choice but are NOT start elements
   * (i.e., elements that appear at position >= 2 in those sequences). Used to avoid leaking follow-up-only
   * items like do_elseif/do_else when not continuing inside that sequence arm.
   */
  private getNonStartElementsInChoiceSequences(choice: Element): Set<string> {
    const ns = 'xs:';
    const names = new Set<string>();

    const collectFromNode = (node: Element) => {
      if (node.nodeName === ns + 'sequence') {
        let seenFirst = false;
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType !== 1) continue;
          const el = child as Element;
          if (el.nodeName === ns + 'element') {
            const nm = el.getAttribute('name');
            if (!nm) continue;
            if (seenFirst) {
              names.add(nm);
            } else {
              seenFirst = true;
            }
          } else if (el.nodeName === ns + 'group') {
            const ref = el.getAttribute('ref');
            const grp = ref ? this.schemaIndex.groups[ref] : el;
            if (grp) {
              const model = this.findDirectContentModel(grp);
              if (model) collectFromNode(model);
            }
          } else if (el.nodeName === ns + 'choice' || el.nodeName === ns + 'sequence') {
            // Dive into nested structures if present
            collectFromNode(el);
          }
        }
      } else if (node.nodeName === ns + 'group') {
        const ref = node.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : node;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) collectFromNode(model);
        }
      } else if (node.nodeName === ns + 'choice') {
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
  }

  /**
   * Handle continuation when the previous element defines an inner content model.
   * Returns the start-capable elements of that inner model, respecting min/maxOccurs.
   * @param previousItem The previous item in the sequence
   * @param previousSibling The name of the previous sibling
   * @param sequenceItems All items in the current sequence
   * @param previousPosition Position of the previous item
   * @param allChildren All possible child elements
   * @returns Remaining valid elements in the inner sequence, or empty array if not applicable
   */
  private getRemainingElementsInInnerSequence(
    previousItem: Element,
    previousSibling: string,
    sequenceItems: Element[],
    previousPosition: number,
    allChildren: Element[]
  ): Element[] {
    // Generic handling: if the previous item defines its own inner content model (sequence/choice/all),
    // propose the initial elements of that inner model. If those inner elements are all optional,
    // append other allowed elements from the parent level after prioritizing the inner ones.
    const ns = 'xs:';

    if (previousItem.nodeName === ns + 'element') {
      const innerModel = this.findContentModel(previousItem);
      if (!innerModel) return [];

      const prioritized: Element[] = [];
      let innerHasRequiredFirst = false;

  if (innerModel.nodeName === ns + 'sequence') {
        // Collect starting elements of the inner sequence, respecting minOccurs
        for (let i = 0; i < innerModel.childNodes.length; i++) {
          const child = innerModel.childNodes[i];
          if (child.nodeType === 1) {
            const item = child as Element;
            const elems = this.getElementsFromSequenceItem(item, allChildren);
            prioritized.push(...elems);
    const minOccurs = this.getEffectiveMinOccurs(item, innerModel);
    if (minOccurs >= 1) {
              innerHasRequiredFirst = true;
              break; // Stop at first required inner item
            }
          }
        }
      } else if (innerModel.nodeName === ns + 'choice') {
        prioritized.push(...this.getElementsInChoice(innerModel, allChildren));
        // In a choice, typically one option is required unless minOccurs=0 on the choice itself
        innerHasRequiredFirst = parseInt(innerModel.getAttribute('minOccurs') || '1') >= 1;
      } else if (innerModel.nodeName === ns + 'all') {
        // For xs:all, any element can appear; treat as optional set
        for (let i = 0; i < innerModel.childNodes.length; i++) {
          const child = innerModel.childNodes[i];
          if (child.nodeType === 1) {
            const item = child as Element;
            const elems = this.getElementsFromSequenceItem(item, allChildren);
            prioritized.push(...elems);
          }
        }
        innerHasRequiredFirst = false;
      }

      // De-duplicate prioritized while preserving order
      const seen = new Set<string>();
      const dedupPrioritized = prioritized.filter(e => {
        const name = e.getAttribute('name') || '';
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });

      if (dedupPrioritized.length === 0) return [];

      // If inner start is all optional, append other elements from parent level
  // If inner start is all optional, do NOT include unrelated alternatives from parent choice here.
  // Only return the inner start-capable elements; the outer sequence logic will handle following items.

      return dedupPrioritized;
    }

    return [];
  }

  /**
   * Check if a sequence item (element, choice, group) contains the specified element
   * @param item The sequence item to check
   * @param elementName The element name to look for
   * @returns True if the item contains the element
   */
  private itemContainsElement(item: Element, elementName: string, visited?: Set<Element>): boolean {
    const ns = 'xs:';
    // Initialize visited set for cycle detection across recursive traversals
    if (!visited) visited = new Set<Element>();

    if (item.nodeName === ns + 'element') {
      return item.getAttribute('name') === elementName;
    } else if (item.nodeName === ns + 'choice') {
      // Check if any element in the choice matches
      return this.choiceContainsElement(item, elementName, visited);
    } else if (item.nodeName === ns + 'sequence') {
      if (visited.has(item)) return false;
      visited.add(item);
      // Check any child of the sequence
      for (let i = 0; i < item.childNodes.length; i++) {
        const child = item.childNodes[i];
        if (child.nodeType === 1) {
          if (this.itemContainsElement(child as Element, elementName, visited)) {
            return true;
          }
        }
      }
      return false;
    } else if (item.nodeName === ns + 'group') {
      if (visited.has(item)) return false;
      visited.add(item);
      // Check if the group contains the element (resolve ref or definition)
      const groupName = item.getAttribute('ref');
      const grp = groupName ? this.schemaIndex.groups[groupName] : item;
      if (grp) {
        const model = this.findDirectContentModel(grp);
        if (model) {
          return this.itemContainsElement(model, elementName, visited);
        }
      }
    }

    return false;
  }

  /**
   * Find a nested sequence within a choice that contains the specified element
   */
  private findNestedSequenceContainingElement(root: Element, elementName: string): Element | null {
    const ns = 'xs:';
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
      if (node.nodeName === ns + 'group') {
        const ref = node.getAttribute('ref');
        const grp = ref ? this.schemaIndex.groups[ref] : node;
        if (grp) {
          const model = this.findDirectContentModel(grp);
          if (model) {
            // If resolved model is a sequence that contains the element, return it
            if (model.nodeName === ns + 'sequence' && this.itemContainsElement(model, elementName)) {
              return model;
            }
            // Otherwise, continue traversal within the resolved model
            if (!visited.has(model)) stack.push(model);
            continue;
          }
        }
      }

      // Direct sequence detection
      if (node.nodeName === ns + 'sequence' && this.itemContainsElement(node, elementName)) {
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
  }

  /**
   * Check if a choice contains the specified element
   * @param choice The choice element
   * @param elementName The element name to look for
   * @returns True if the choice contains the element
   */
  private choiceContainsElement(choice: Element, elementName: string, visited?: Set<Element>): boolean {
    const ns = 'xs:';
    // Initialize visited set for cycle detection across recursive traversals
    if (!visited) visited = new Set<Element>();
    if (visited.has(choice)) return false;
    visited.add(choice);

    for (let i = 0; i < choice.childNodes.length; i++) {
      const child = choice.childNodes[i];
      if (child.nodeType === 1) {
        const element = child as Element;

        if (element.nodeName === ns + 'element' && element.getAttribute('name') === elementName) {
          return true;
        } else if (element.nodeName === ns + 'choice') {
          if (this.choiceContainsElement(element, elementName, visited)) {
            return true;
          }
        } else if (element.nodeName === ns + 'sequence') {
          // A sequence can be an alternative in a choice (e.g., do_if/do_elseif/do_else)
          // Delegate to generic itemContainsElement to search within the sequence
          if (this.itemContainsElement(element, elementName, visited)) {
            return true;
          }
        } else if (element.nodeName === ns + 'group') {
          const groupName = element.getAttribute('ref');
          const grp = groupName ? this.schemaIndex.groups[groupName] : element;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model && this.itemContainsElement(model, elementName, visited)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if a sequence item can repeat (for the specific element)
   * @param item The sequence item
   * @param elementName The element name
   * @returns True if the element can repeat
   */
  private itemCanRepeat(item: Element, elementName: string): boolean {
    const ns = 'xs:';

    if (item.nodeName === ns + 'element' && item.getAttribute('name') === elementName) {
      const maxOccurs = item.getAttribute('maxOccurs') || '1';
      return maxOccurs === 'unbounded' || parseInt(maxOccurs) > 1;
    } else if (item.nodeName === ns + 'choice') {
      // For choice, check if the choice itself can repeat
      const maxOccurs = item.getAttribute('maxOccurs') || '1';
      return maxOccurs === 'unbounded' || parseInt(maxOccurs) > 1;
    } else if (item.nodeName === ns + 'group') {
      // Repetition on the group reference itself
      const maxOccurs = item.getAttribute('maxOccurs') || '1';
      return maxOccurs === 'unbounded' || parseInt(maxOccurs) > 1;
    }

    return false;
  }

  /**
   * Get elements from a sequence item (element, choice, group)
   * @param item The sequence item
   * @param allChildren All possible child elements for reference
   * @returns Array of elements from the item
   */
  private getElementsFromSequenceItem(item: Element, allChildren: Element[]): Element[] {
    const ns = 'xs:';

    if (item.nodeName === ns + 'element') {
      const elementName = item.getAttribute('name');
      if (elementName) {
        const element = allChildren.find(elem => elem.getAttribute('name') === elementName);
        return element ? [element] : [];
      }
    } else if (item.nodeName === ns + 'choice') {
      return this.getElementsInChoice(item, allChildren);
    } else if (item.nodeName === ns + 'sequence') {
      // When asked generically, return only the start-capable elements of this sequence
      return this.getStartElementsOfSequence(item, allChildren);
    } else if (item.nodeName === ns + 'group') {
      const groupName = item.getAttribute('ref');
      const grp = groupName ? this.schemaIndex.groups[groupName] : item;
      if (grp) {
        const model = this.findDirectContentModel(grp);
        if (model) {
          if (model.nodeName === ns + 'choice') {
            return this.getElementsInChoice(model, allChildren);
          } else if (model.nodeName === ns + 'sequence') {
            return this.getStartElementsOfSequence(model, allChildren);
          } else if (model.nodeName === ns + 'all') {
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
  }

  /**
   * Get all elements within a choice
   * @param choice The choice element
   * @param allChildren All possible child elements for reference
   * @returns Array of elements that are options in the choice
   */
  private getElementsInChoice(choice: Element, allChildren: Element[]): Element[] {
    const ns = 'xs:';
    const choiceElements: Element[] = [];

    for (let i = 0; i < choice.childNodes.length; i++) {
      const child = choice.childNodes[i];
      if (child.nodeType === 1) {
        const element = child as Element;

        if (element.nodeName === ns + 'element') {
          const elementName = element.getAttribute('name');
          if (elementName) {
            const foundElement = allChildren.find(elem => elem.getAttribute('name') === elementName);
            if (foundElement) {
              choiceElements.push(foundElement);
            }
          }
        } else if (element.nodeName === ns + 'choice') {
          // Nested choice: include only its start-capable options
          choiceElements.push(...this.getElementsInChoice(element, allChildren));
        } else if (element.nodeName === ns + 'sequence') {
          // Sequence within choice: only include elements that can start that sequence (not follow-up-only items)
          choiceElements.push(...this.getStartElementsOfSequence(element, allChildren));
        } else if (element.nodeName === ns + 'group') {
          // Resolve group (ref or definition) to its direct content model and include start-capable options
          const groupName = element.getAttribute('ref');
          const grp = groupName ? this.schemaIndex.groups[groupName] : element;
          if (grp) {
            const model = this.findDirectContentModel(grp);
            if (model) {
              if (model.nodeName === ns + 'choice') {
                choiceElements.push(...this.getElementsInChoice(model, allChildren));
              } else if (model.nodeName === ns + 'sequence') {
                choiceElements.push(...this.getStartElementsOfSequence(model, allChildren));
              } else if (model.nodeName === ns + 'all') {
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
  }

  /**
   * Get the set of elements that can legally start the provided sequence, honoring minOccurs on leading items.
   */
  private getStartElementsOfSequence(seq: Element, allChildren: Element[]): Element[] {
    const ns = 'xs:';
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
  }

  /**
   * Return the elements that can appear at the start position of a sequence item.
   */
  private getStartElementsFromItem(item: Element, allChildren: Element[]): Element[] {
    const ns = 'xs:';
    if (item.nodeName === ns + 'element') {
      const elementName = item.getAttribute('name');
      if (elementName) {
        const foundElement = allChildren.find(e => e.getAttribute('name') === elementName);
        return foundElement ? [foundElement] : [];
      }
      return [];
    } else if (item.nodeName === ns + 'choice') {
      return this.getElementsInChoice(item, allChildren);
    } else if (item.nodeName === ns + 'sequence') {
      return this.getStartElementsOfSequence(item, allChildren);
    } else if (item.nodeName === ns + 'group') {
      // Resolve group (ref or definition) to its direct content model
      const groupName = item.getAttribute('ref');
      const grp = groupName ? this.schemaIndex.groups[groupName] : item;
      if (grp) {
        const model = this.findDirectContentModel(grp);
        if (model) {
          if (model.nodeName === ns + 'choice') {
            return this.getElementsInChoice(model, allChildren);
          } else if (model.nodeName === ns + 'sequence') {
            return this.getStartElementsOfSequence(model, allChildren);
          } else if (model.nodeName === ns + 'all') {
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
    const builtInTypes = [
      'string', 'int', 'integer', 'decimal', 'boolean', 'date', 'time', 'dateTime',
      'duration', 'float', 'double', 'anyURI', 'QName', 'NOTATION'
    ];

    const localName = typeName.includes(':') ? typeName.split(':')[1] : typeName;
    return builtInTypes.includes(localName);
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
    // Look up the type in the schema index
    const typeNode = this.schemaIndex.types[simpleTypeName];
    if (!typeNode) {
      return null; // Type not found
    }

    // Check if this is a simpleType
    const ns = 'xs:';
    if (typeNode.nodeName !== ns + 'simpleType') {
      return null; // Not a simple type
    }

    // Extract enumeration values from the simple type, including union member types
    const allEnumValues: string[] = [];
    const allAnnotations = new Map<string, string>();

    // First, try to extract direct enumeration values
    const validationInfo: Partial<EnhancedAttributeInfo> = {};
    this.extractValidationRulesFromNode(typeNode, validationInfo);

    if (validationInfo.enumValues && validationInfo.enumValues.length > 0) {
      allEnumValues.push(...validationInfo.enumValues);
      const directAnnotations = this.extractEnumValueAnnotations(typeNode);
      for (const [key, value] of directAnnotations) {
        allAnnotations.set(key, value);
      }
    }

    // Check for union types and extract enumeration values from member types
    const unions = this.findChildElements(typeNode, ns + 'union');
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
  }

  /**
   * Clear all caches and resources
   */
  public dispose(): void {
    this.initializeCaches();
  }
}
