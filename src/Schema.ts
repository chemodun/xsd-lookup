import * as fs from 'fs';
import * as path from 'path';
import { DOMParser } from 'xmldom';

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
}

interface PerformanceMetrics {
  cacheHits: number;
  cacheMisses: number;
  totalLookups: number;
  avgSearchDepth: number;
}

interface AttributeInfo {
  name: string;
  node: Element;
  type?: string;
  required?: boolean;
  enumValues?: string[];
  patterns?: string[]; // Changed to support multiple patterns
  minLength?: number;
  maxLength?: number;
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
}

interface AttributeValidationResult {
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
  private metrics!: PerformanceMetrics;
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
    this.schemaIndex = this.indexSchema(this.doc.documentElement);
    this.elementMap = this.buildElementMap();
    this.elementContexts = this.schemaIndex.elementContexts;
  }

  private initializeCaches(): void {
    this.cache = {
      hierarchyLookups: new Map(),
      definitionReachability: new Map(),
      elementSearchResults: new Map(),
      attributeCache: new Map(),
      hierarchyValidation: new Map()
    };

    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      totalLookups: 0,
      avgSearchDepth: 0
    };
  }

  public getCacheStats(): PerformanceMetrics {
    return { ...this.metrics };
  }

  public clearCache(): void {
    this.initializeCaches();
  }

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
  }

  private loadXml(filePath: string): Document {
    const xml = fs.readFileSync(filePath, 'utf8');
    return new DOMParser().parseFromString(xml, 'application/xml');
  }

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
  private buildElementMap(): Record<string, ElementMapEntry[]> {
    const elements = this.collectElements(this.doc.documentElement, null);
    const elementMap: Record<string, ElementMapEntry[]> = {};
    elements.forEach(e => {
      if (!elementMap[e.name]) elementMap[e.name] = [];
      elementMap[e.name].push({ parent: e.parent, node: e.node });
    });
    return elementMap;
  }
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
          // Only pass the immediate parent element, not the full chain
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
    // Step 1: If no hierarchy provided, only return global elements
    if (hierarchy.length === 0) {
      // Look for global elements (direct children of schema root)
      const globalElements = this.getGlobalElementDefinitions(elementName);
      return globalElements.length > 0 ? globalElements[0] : undefined;
    }

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
        // Found a definition at this level - check if it's unique enough
        // For now, return the first match (we can add uniqueness checking later)
        return foundElement;
      }
    }

    // No definition found at any hierarchy level
    return undefined;
  }

  /**
   * Check if an element context can appear in the given parent within the hierarchy
   */
  private canElementAppearInParent(context: ElementContext, parentName: string, hierarchy: string[]): boolean {
    // If the context has explicit parent information, use it
    if (context.parents.length > 0) {
      return context.parents.includes(parentName);
    }

    // If the context belongs to groups, check if those groups can appear in the parent
    if (context.groups.length > 0) {
      for (const groupName of context.groups) {
        if (this.canGroupAppearInParent(groupName, parentName)) {
          return true;
        }
      }
    }

    // If no specific parent/group information, this might be a global element
    // that can appear anywhere - we'll need to check via the old method as fallback
    return this.canElementAppearInParentViaSearch(context.element, parentName);
  }

  /**
   * Check if a group can appear in a given parent element
   */
  private canGroupAppearInParent(groupName: string, parentName: string): boolean {
    // Get the parent element/type definitions
    const parentDefs = this.getGlobalElementOrTypeDefs(parentName);

    for (const parentDef of parentDefs) {
      if (this.doesDefinitionReferenceGroup(parentDef, groupName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a definition (element or type) references a specific group
   */
  private doesDefinitionReferenceGroup(definition: Element, groupName: string): boolean {
    const ns = 'xs:';
    const visited = new Set<string>();

    const searchForGroupRef = (node: Element): boolean => {
      if (!node || node.nodeType !== 1) return false;

      const nodeKey = `${node.nodeName}:${node.getAttribute('name') || node.getAttribute('ref') || 'anon'}`;
      if (visited.has(nodeKey)) return false;
      visited.add(nodeKey);

      // Check if this is a direct group reference to our target group
      if (node.nodeName === ns + 'group' && node.getAttribute('ref') === groupName) {
        return true;
      }

      // Handle type references
      if (node.nodeName === ns + 'element') {
        const typeName = node.getAttribute('type');
        if (typeName && this.schemaIndex.types[typeName]) {
          if (searchForGroupRef(this.schemaIndex.types[typeName])) {
            return true;
          }
        }
      }

      // Recursively search children
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          if (searchForGroupRef(child as Element)) {
            return true;
          }
        }
      }

      return false;
    };

    return searchForGroupRef(definition);
  }

  /**
   * Fallback method to check if an element can appear in a parent via dynamic search
   */
  private canElementAppearInParentViaSearch(elementNode: Element, parentName: string): boolean {
    const parentDefs = this.getGlobalElementOrTypeDefs(parentName);

    for (const parentDef of parentDefs) {
      const foundElements = this.findElementsInDefinition(parentDef, elementNode.getAttribute('name') || '');
      if (foundElements.some(found => found === elementNode)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Select the best context match from multiple matching contexts
   */
  private selectBestContextMatch(contexts: ElementContext[], hierarchy: string[]): Element {
    if (contexts.length === 1) {
      return contexts[0].element;
    }

    // Score each context based on how well it matches the hierarchy
    const scoredContexts = contexts.map(ctx => {
      let score = 0;

      // HIGHEST PRIORITY: Prefer contexts with fewer parents (more specific)
      // A context with Parents=[order] is more specific than Parents=[params, aiscript]
      // This should be the dominant factor - use much higher weights
      score += (100 - ctx.parents.length) * 10; // Much higher weight for specificity

      // SECOND PRIORITY: Prefer contexts whose parents appear earlier in hierarchy (more specific)
      // In hierarchy [library, interrupts, aiscript], "library" at index 0 is more specific than "interrupts" at index 1
      for (const parent of ctx.parents) {
        const hierarchyIndex = hierarchy.indexOf(parent);
        if (hierarchyIndex !== -1) {
          // Give higher score to parents that appear earlier in hierarchy (more specific/closer to element)
          score += (hierarchy.length - hierarchyIndex) * 10; // Lower index = more specific
        }
      }

      // THIRD PRIORITY: Prefer contexts that have exact parent matches in the hierarchy
      for (let i = 0; i < hierarchy.length && i < ctx.parents.length; i++) {
        if (ctx.parents[i] === hierarchy[i]) {
          score += 5; // Reduced weight for exact match
        }
      }

      // FOURTH PRIORITY: General bonus for parents that appear in the hierarchy
      for (const parent of ctx.parents) {
        if (hierarchy.includes(parent)) {
          score += 2; // Reduced weight for general bonus
        }
      }

      // Add small bonus for having parent information at all
      score += ctx.parents.length * 0.1; // Very small bonus

      // Add small bonus for group membership
      score += ctx.groups.length * 0.1; // Very small bonus

      return { context: ctx, score };
    });

    // Sort by score (highest first)
    scoredContexts.sort((a, b) => b.score - a.score);

    return scoredContexts[0].context.element;
  }

  private getGlobalElementDefinitions(elementName: string): Element[] {
    // Only return truly global elements (direct children of schema root)
    if (this.schemaIndex.elements[elementName]) {
      return this.schemaIndex.elements[elementName];
    }

    // Do NOT fall back to elementMap as it contains nested elements too
    return [];
  }

  private findElementInHierarchyPath(elementName: string, hierarchy: string[]): Element | null {
    if (hierarchy.length === 0) return null;

    // Create cache key
    const cacheKey = `${elementName}:${hierarchy.join('>')}`;

    // Check cache first
    if (this.cache.hierarchyLookups.has(cacheKey)) {
      this.metrics.cacheHits++;
      this.metrics.totalLookups++;
      return this.cache.hierarchyLookups.get(cacheKey)!;
    }

    this.metrics.cacheMisses++;
    this.metrics.totalLookups++;

    // Start from the most general context (root) and work down to specific
    // hierarchy is [parent, grandparent, great-grandparent, ...] so we reverse it
    const reversedHierarchy = [...hierarchy].reverse();

    // Try to find element by walking down the hierarchy from root to target
    const walkHierarchy = (currentLevel: number, currentDefs: Element[]): Element[] => {
      if (currentLevel >= reversedHierarchy.length) {
        // We've reached the target level, look for the element
        const results: Element[] = [];
        for (const def of currentDefs) {
          const found = this.findElementsInDefinitionCached(def, elementName);
          results.push(...found);
          // Early exit optimization: if we found a result, don't keep searching
          if (results.length > 0) break;
        }
        return results;
      }

      // Get the next level in the hierarchy
      const nextElementName = reversedHierarchy[currentLevel];
      const nextLevelDefs: Element[] = [];

      for (const def of currentDefs) {
        const found = this.findElementsInDefinitionCached(def, nextElementName);
        nextLevelDefs.push(...found);
        // Early exit optimization: if we have enough definitions, stop searching
        if (nextLevelDefs.length >= 3) break;
      }

      if (nextLevelDefs.length === 0) return [];

      // Continue walking down the hierarchy
      return walkHierarchy(currentLevel + 1, nextLevelDefs);
    };

    // Start with all possible root definitions
    const rootElementName = reversedHierarchy[0];
    const rootDefs = this.getGlobalElementOrTypeDefs(rootElementName);

    if (rootDefs.length === 0) {
      // Cache the null result
      this.cache.hierarchyLookups.set(cacheKey, null);
      this.ensureCacheSize();
      return null;
    }

    // Walk the hierarchy starting from level 1 (after root)
    const foundElements = walkHierarchy(1, rootDefs);

    // Return the first (most specific) match
    const result = foundElements.length > 0 ? foundElements[0] : null;

    // Cache the result
    this.cache.hierarchyLookups.set(cacheKey, result);
    this.ensureCacheSize();

    return result;
  }

  // Keep the old method for backward compatibility
  private findElementInHierarchy(elementName: string, parentName?: string, grandparentName?: string): Element | null {
    const contextCandidates: Element[] = [];

    // Priority 1: Three-level context (element in parent in grandparent)
    if (grandparentName) {
      const grandparentDefs = this.getGlobalElementOrTypeDefs(grandparentName);
      for (const grandparentDef of grandparentDefs) {
        const parentDefs = this.findElementsInDefinition(grandparentDef, parentName!);
        for (const parentDef of parentDefs) {
          const elementDef = this.findElementsInDefinition(parentDef, elementName);
          if (elementDef.length > 0) contextCandidates.push(...elementDef);
        }
      }
    }

    // Priority 2: Two-level context (element in parent)
    if (parentName) {
      const parentDefs = this.getGlobalElementOrTypeDefs(parentName);
      for (const parentDef of parentDefs) {
        const elementDefs = this.findElementsInDefinition(parentDef, elementName);
        if (elementDefs.length > 0) contextCandidates.push(...elementDefs);
      }
    }

    // Return the first (most specific) match
    return contextCandidates.length > 0 ? contextCandidates[0] : null;
  }

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
  }  private findElementsInDefinition(parentDef: Element, elementName: string): Element[] {
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

    // Update metrics
    this.metrics.avgSearchDepth = (this.metrics.avgSearchDepth + maxSearchDepth) / 2;

    return results;
  }  private findElementsInDefinitionCached(parentDef: Element, elementName: string): Element[] {
    // Create cache key based on parent definition and element name
    const parentKey = parentDef.getAttribute('name') || parentDef.getAttribute('type') || 'anonymous';
    const cacheKey = `${parentKey}:${elementName}:${parentDef.nodeName}`;

    // Check cache first
    if (this.cache.elementSearchResults.has(cacheKey)) {
      // Don't increment metrics here - this is an internal cache for performance only
      return this.cache.elementSearchResults.get(cacheKey)!;
    }

    // Delegate to original method
    const results = this.findElementsInDefinition(parentDef, elementName);

    // Cache the results
    this.cache.elementSearchResults.set(cacheKey, results);
    this.ensureCacheSize();

    return results;
  }  public getElementAttributes(elementName: string, hierarchy: string[] = []): AttributeInfo[] {
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

  private getElementAttributesWithHierarchy(elementName: string, hierarchy: string[]): AttributeInfo[] {
    // Create cache key
    const cacheKey = `attrs:${elementName}:${hierarchy.join('>')}`;

    // Check cache first
    if (this.cache.attributeCache.has(cacheKey)) {
      this.metrics.cacheHits++;
      this.metrics.totalLookups++;
      return this.cache.attributeCache.get(cacheKey)!;
    }

    this.metrics.cacheMisses++;
    this.metrics.totalLookups++;

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
   * Select the best element definition based on hierarchical context.
   * Uses full hierarchy analysis to determine which definition is reachable.
   */
  private selectBestDefinitionByContext(elementName: string, definitions: Element[], hierarchy: string[]): Element[] {
    if (definitions.length <= 1) {
      return definitions;
    }

    // If no hierarchy provided, return all definitions
    if (hierarchy.length === 0) {
      return definitions;
    }

    // For each definition, check if it can be reached through the given hierarchy
    const reachableDefs = definitions.filter(def => {
      return this.isDefinitionReachableFromHierarchy(def, elementName, hierarchy);
    });

    if (reachableDefs.length > 0) {
      return reachableDefs;
    }

    // If no definition is reachable through the hierarchy, try a simpler parent-only check
    const parentReachableDefs = definitions.filter(def => {
      return this.isDefinitionReachableFromParent(def, hierarchy[0], elementName);
    });

    if (parentReachableDefs.length > 0) {
      return parentReachableDefs;
    }

    // Return all definitions if no clear match found
    return definitions;
  }  /**
   * Check if an element definition is reachable from a parent element context
   * by analyzing the schema structure dynamically (with caching)
   */
  private isDefinitionReachableFromParent(elementDef: Element, parentElementName: string, targetElementName: string): boolean {
    // Create cache key for definition reachability
    const elementDefKey = elementDef.getAttribute('name') || elementDef.getAttribute('type') || 'anonymous';
    const cacheKey = `reach:${elementDefKey}:${parentElementName}:${targetElementName}`;

    // Check cache first (internal cache, don't track metrics)
    if (this.cache.definitionReachability.has(cacheKey)) {
      return this.cache.definitionReachability.get(cacheKey)!;
    }

    // Get all possible parent element definitions
    const parentDefs = this.getGlobalElementOrTypeDefs(parentElementName);

    // Check if the target element (with this specific definition) can be found within any parent definition
    let result = false;
    for (const parentDef of parentDefs) {
      if (this.canElementDefinitionBeFoundInParent(parentDef, targetElementName, elementDef)) {
        result = true;
        break; // Early exit optimization
      }
    }

    // Cache the result
    this.cache.definitionReachability.set(cacheKey, result);
    this.ensureCacheSize();

    return result;
  }

  /**
   * Check if a specific element definition can be found within a parent definition's context
   */
  private canElementDefinitionBeFoundInParent(parentDef: Element, targetElementName: string, targetElementDef: Element): boolean {
    const foundElements = this.findElementsInDefinition(parentDef, targetElementName);

    // Check if any of the found elements matches our specific definition
    // We can compare by checking if they have the same attribute group or type structure
    for (const foundElement of foundElements) {
      if (this.areElementDefinitionsEquivalent(foundElement, targetElementDef)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Compare two element definitions to see if they are equivalent
   */
  private areElementDefinitionsEquivalent(def1: Element, def2: Element): boolean {
    // First check if they are the exact same node
    if (def1 === def2) {
      return true;
    }

    // Compare element name
    const name1 = def1.getAttribute('name');
    const name2 = def2.getAttribute('name');
    if (name1 !== name2) {
      return false;
    }

    // Compare type attribute
    const type1 = def1.getAttribute('type');
    const type2 = def2.getAttribute('type');
    if (type1 !== type2) {
      return false;
    }

    // Compare by attribute groups
    const attrGroup1 = this.getElementAttributeGroup(def1);
    const attrGroup2 = this.getElementAttributeGroup(def2);

    if (attrGroup1 && attrGroup2) {
      if (attrGroup1 !== attrGroup2) {
        return false;
      }
    } else if (attrGroup1 !== attrGroup2) {
      // One has attribute group, the other doesn't
      return false;
    }

    // Compare other key attributes that might make them different
    const minOccurs1 = def1.getAttribute('minOccurs');
    const minOccurs2 = def2.getAttribute('minOccurs');
    if (minOccurs1 !== minOccurs2) {
      return false;
    }

    const maxOccurs1 = def1.getAttribute('maxOccurs');
    const maxOccurs2 = def2.getAttribute('maxOccurs');
    if (maxOccurs1 !== maxOccurs2) {
      return false;
    }

    // If we have the same name, type, attribute groups, and occurrence constraints,
    // consider them equivalent
    return true;
  }  /**
   * Extract the primary attribute group reference from an element definition
   */
  private getElementAttributeGroup(elementDef: Element): string | null {
    // Look for inline complexType
    for (let i = 0; i < elementDef.childNodes.length; i++) {
      const child = elementDef.childNodes[i];
      if (child.nodeType === 1 && (child as Element).nodeName === 'xs:complexType') {
        // Check for attributeGroup references in complexType
        for (let j = 0; j < child.childNodes.length; j++) {
          const grandchild = child.childNodes[j];
          if (grandchild.nodeType === 1 && (grandchild as Element).nodeName === 'xs:attributeGroup') {
            const ref = (grandchild as Element).getAttribute('ref');
            if (ref) {
              return ref;
            }
          }
        }
      }
    }

    return null;
  }  /**
   * Check if an element definition is reachable through a full hierarchy path.
   * This walks through the entire hierarchy to validate the path is valid in the schema.
   * (Optimized with caching and early exits)
   */
  private isDefinitionReachableFromHierarchy(elementDef: Element, targetElementName: string, hierarchy: string[]): boolean {
    if (hierarchy.length === 0) return false;

    // Create cache key for hierarchy validation
    const elementDefKey = elementDef.getAttribute('name') || elementDef.getAttribute('type') || 'anonymous';
    const cacheKey = `hierarchy:${elementDefKey}:${targetElementName}:${hierarchy.join('>')}`;

    // Check cache first (internal cache, don't track metrics)
    if (this.cache.hierarchyValidation.has(cacheKey)) {
      return this.cache.hierarchyValidation.get(cacheKey)!;
    }

    // Start from the root of the hierarchy and walk down to see if we can reach the target element
    // hierarchy is [parent, grandparent, great-grandparent, ...] so we need to reverse it
    const reversedHierarchy = [...hierarchy].reverse();

    // Get all possible starting points (root elements)
    const rootElementName = reversedHierarchy[0];
    const rootDefs = this.getGlobalElementOrTypeDefs(rootElementName);

    if (rootDefs.length === 0) {
      this.cache.hierarchyValidation.set(cacheKey, false);
      this.ensureCacheSize();
      return false;
    }

    // Walk through the hierarchy step by step with optimizations
    const walkHierarchyForDefinition = (currentLevel: number, currentDefs: Element[]): boolean => {
      // If we've reached the parent level, check if we can find the target element with the specific definition
      if (currentLevel >= reversedHierarchy.length) {
        // Now look for the target element in these definitions
        for (const parentDef of currentDefs) {
          const foundElements = this.findElementsInDefinitionCached(parentDef, targetElementName);
          // Check if any found element matches our specific definition
          for (const foundElement of foundElements) {
            if (this.areElementDefinitionsEquivalent(foundElement, elementDef)) {
              return true;
            }
          }
        }
        return false;
      }

      // Get the next level in the hierarchy
      const nextElementName = reversedHierarchy[currentLevel];
      const nextLevelDefs: Element[] = [];

      // Find all instances of the next element in the current definitions
      for (const currentDef of currentDefs) {
        const found = this.findElementsInDefinitionCached(currentDef, nextElementName);
        nextLevelDefs.push(...found);
        // Performance optimization: limit number of definitions to explore
        if (nextLevelDefs.length >= 5) break;
      }

      if (nextLevelDefs.length === 0) return false;

      // Continue walking down the hierarchy
      return walkHierarchyForDefinition(currentLevel + 1, nextLevelDefs);
    };

    // Start the walk from level 1 (since level 0 is the root we already have)
    const result = walkHierarchyForDefinition(1, rootDefs);

    // Cache the result
    this.cache.hierarchyValidation.set(cacheKey, result);
    this.ensureCacheSize();

    return result;
  }

  /**
   * Get enhanced attribute information including type and validation details
   */
  public getElementAttributesWithTypes(elementName: string, hierarchy: string[] = []): AttributeInfo[] {
    const attributes = this.getElementAttributes(elementName, hierarchy);

    // Enhance each attribute with type information
    return attributes.map(attr => {
      const enhancedAttr: AttributeInfo = {
        name: attr.name,
        node: attr.node,
        type: attr.node.getAttribute('type') || undefined,
        required: attr.node.getAttribute('use') === 'required'
      };

      // If the attribute has a type, get comprehensive validation information
      if (enhancedAttr.type) {
        const typeValidation = this.getTypeValidationInfo(enhancedAttr.type);
        Object.assign(enhancedAttr, typeValidation);
      }

      return enhancedAttr;
    });
  }

  /**
   * Get comprehensive validation information for a type
   */
  private getTypeValidationInfo(typeName: string): Partial<AttributeInfo> {
    const typeNode = this.schemaIndex.types[typeName];
    if (!typeNode) return {};

    const validationInfo: Partial<AttributeInfo> = {};
    const ns = 'xs:';

    const extractValidationRules = (node: Element): void => {
      if (!node || node.nodeType !== 1) return;

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

      // Recursively search child nodes
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          extractValidationRules(child as Element);
        }
      }
    };

    extractValidationRules(typeNode);
    return validationInfo;
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
  private validateValueWithRestrictions(value: string, attrInfo: AttributeInfo): AttributeValidationResult {
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
   * Check if multiple element definitions are equivalent and return one if they are
   * @param elements Array of element definitions to compare
   * @returns Single element if all are equivalent, undefined if they differ
   */
  private getUniqueElementIfEquivalent(elements: Element[]): Element | undefined {
    if (elements.length <= 1) {
      return elements[0];
    }

    // Use the first element as the reference for comparison
    const referenceElement = elements[0];

    // Check if all elements are equivalent to the reference
    for (let i = 1; i < elements.length; i++) {
      if (!this.areElementDefinitionsEquivalent(referenceElement, elements[i])) {
        // Found a non-equivalent element, so they're not all the same
        return undefined;
      }
    }

    // All elements are equivalent, return the first one
    return referenceElement;
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
}
