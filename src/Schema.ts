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

    const walk = (node: Node): void => {
      if (!node || node.nodeType !== 1) return;
      const element = node as Element;

      if (element.nodeName === ns + 'element' && element.getAttribute('name')) {
        const name = element.getAttribute('name')!;
        if (!elements[name]) elements[name] = [];  // Initialize array if needed
        elements[name].push(element);  // Push to array instead of overwriting
      }
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
      for (let i = 0; i < element.childNodes.length; i++) {
        walk(element.childNodes[i]);
      }
    };

    walk(root);
    return { elements, groups, attributeGroups, types, elementContexts: {} };
  }  public getElementDefinition(elementName: string, hierarchy: string[] = []): Element[] {
    // Smart hierarchy resolution: try different hierarchy depths for better matches
    const hierarchyOptions = [
      hierarchy.slice(-1),    // Just immediate parent
      hierarchy.slice(-2),    // Parent + grandparent
      hierarchy.slice(-3),    // Last 3 levels
      hierarchy,              // Full hierarchy
      []                      // No hierarchy (global fallback)
    ];

    for (const hierarchyVariant of hierarchyOptions) {
      const result = this.getElementDefinitionWithHierarchy(elementName, hierarchyVariant);
      if (result.length > 0) {
        return result;
      }
    }

    return [];
  }

  private getElementDefinitionWithHierarchy(elementName: string, hierarchy: string[]): Element[] {

    // Strategy 1: Context-specific lookup - find element within hierarchical context
    if (hierarchy.length > 0) {
      const contextDef = this.findElementInHierarchyPath(elementName, hierarchy);
      if (contextDef) {
        return [contextDef];
      }
    }    // Strategy 2: Direct global element lookup with context filtering
    if (this.schemaIndex.elements[elementName]) {
      const allDefs = this.schemaIndex.elements[elementName];
      return this.selectBestDefinitionByContext(elementName, allDefs, hierarchy);
    }// Strategy 3: Search in elementMap with parent context preference
    const defs = this.elementMap[elementName] || [];
    if (defs.length) {
      // If hierarchy provided, prefer exact parent match
      const parentName = hierarchy.length > 0 ? hierarchy[0] : undefined;
      if (parentName) {
        const parentDefs = defs.filter(d => d.parent === parentName);
        if (parentDefs.length) {
          return parentDefs.map(d => d.node);
        }
      }

      // If only one definition exists, use it
      if (defs.length === 1) return defs.map(d => d.node);

      // If no parentName or no match, but all parents are null, use them
      if (defs.every(d => !d.parent)) return defs.map(d => d.node);

      // If we have definitions but no exact match, use the first one as fallback
      return [defs[0].node];
    }

    return [];
  }  private findElementInHierarchyPath(elementName: string, hierarchy: string[]): Element | null {
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
          if (elementDef.length > 0) {
            contextCandidates.push(...elementDef);
          }
        }
      }
    }

    // Priority 2: Two-level context (element in parent)
    if (parentName) {
      const parentDefs = this.getGlobalElementOrTypeDefs(parentName);
      for (const parentDef of parentDefs) {
        const elementDefs = this.findElementsInDefinition(parentDef, elementName);
        if (elementDefs.length > 0) {
          contextCandidates.push(...elementDefs);
        }
      }
    }

    // Return the first (most specific) match
    return contextCandidates.length > 0 ? contextCandidates[0] : null;
  }

  private getGlobalElementOrTypeDefs(name: string): Element[] {
    const defs: Element[] = [];
      // Check global elements
    if (this.schemaIndex.elements[name]) {
      defs.push(...this.schemaIndex.elements[name]);  // Spread the array
    }

    // Check global types
    if (this.schemaIndex.types[name]) {
      defs.push(this.schemaIndex.types[name]);
    }

    // Check elementMap for additional definitions
    const mapDefs = this.elementMap[name] || [];
    defs.push(...mapDefs.map(d => d.node));

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
    const visited = new Set<string>();

    const searchInNode = (node: Element, depth: number = 0): void => {
      if (!node || node.nodeType !== 1) return;

      // Track maximum search depth for metrics
      maxSearchDepth = Math.max(maxSearchDepth, depth);

      // Depth limit for performance - prevent excessive recursion
      if (depth > 20) return;

      // Create a more specific key that includes the search context to avoid false positive cycles
      const nodeId = node.getAttribute('name') || node.getAttribute('ref') || 'anonymous';
      const key = `${node.nodeName}:${nodeId}:${elementName}:${depth}`;

      // Only skip if we've seen this exact same search context before
      if (visited.has(key)) return;
      visited.add(key);

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
    // Smart hierarchy resolution: try different hierarchy depths for better attribute matches
    const hierarchyOptions = [
      hierarchy.slice(-1),    // Just immediate parent (often best for attributes)
      hierarchy.slice(-2),    // Parent + grandparent
      hierarchy.slice(-3),    // Last 3 levels
      hierarchy,              // Full hierarchy
      []                      // No hierarchy (global fallback)
    ];

    for (const hierarchyVariant of hierarchyOptions) {
      const result = this.getElementAttributesWithHierarchy(elementName, hierarchyVariant);
      if (result.length > 0) {
        return result;
      }
    }

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
    const defs = this.getElementDefinition(elementName, hierarchy);
    if (defs.length === 0) {
      // Cache empty result
      const emptyResult: AttributeInfo[] = [];
      this.cache.attributeCache.set(cacheKey, emptyResult);
      this.ensureCacheSize();
      return emptyResult;
    }

    // Use the first (most specific) definition
    const bestDef = defs[0];

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
    // Compare by attribute groups first
    const attrGroup1 = this.getElementAttributeGroup(def1);
    const attrGroup2 = this.getElementAttributeGroup(def2);

    if (attrGroup1 && attrGroup2) {
      return attrGroup1 === attrGroup2;
    }

    // If no attribute groups, compare by node identity (same definition)
    return def1 === def2;
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
}
