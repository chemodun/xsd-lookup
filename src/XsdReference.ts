import * as fs from 'fs';
import * as path from 'path';
import { Schema } from './Schema';
import { XsdDetector } from './XsdDetector';

export class XsdReference {
  private schemas: Map<string, Schema> = new Map();
  private xsdDirectory: string;

  constructor(xsdDirectory: string) {
    this.xsdDirectory = xsdDirectory;
  }

  /**
   * Discover and parse XSD includes from a schema file
   */
  private discoverIncludes(xsdFilePath: string): string[] {
    try {
      const content = fs.readFileSync(xsdFilePath, 'utf8');
      const includes: string[] = [];

      // Find all xs:include elements with schemaLocation
      const includeMatches = content.matchAll(/xs:include\s+schemaLocation\s*=\s*["']([^"']+)["']/g);

      for (const match of includeMatches) {
        const includeFile = match[1];
        const includePath = path.join(this.xsdDirectory, includeFile);

        if (fs.existsSync(includePath)) {
          includes.push(includePath);
        }
      }

      return includes;
    } catch (error) {
      console.warn(`Warning: Could not parse includes from ${xsdFilePath}:`, error);
      return [];
    }
  }

  /**
   * Load a schema dynamically based on schema name
   */
  private loadSchema(schemaName: string): Schema | null {
    // Check if already loaded
    if (this.schemas.has(schemaName)) {
      return this.schemas.get(schemaName)!;
    }

    // Try to find the XSD file
    const xsdPath = path.join(this.xsdDirectory, `${schemaName}.xsd`);

    if (!fs.existsSync(xsdPath)) {
      console.warn(`Schema file not found: ${xsdPath}`);
      return null;
    }

    try {
      // Discover includes
      const includes = this.discoverIncludes(xsdPath);

      // Create and cache the schema
      const schema = new Schema(xsdPath, includes);
      this.schemas.set(schemaName, schema);

      return schema;
    } catch (error) {
      console.error(`Error loading schema ${schemaName}:`, error);
      return null;
    }  }  /**
   * Get the appropriate schema for a given XML file (legacy method)
   * @deprecated Use XsdDetector.detectSchemaFromXml() and then getSchema() instead
   */
  public getSchemaForFile(xmlFilePath: string): Schema | null {
    const fileInfo = XsdDetector.detectSchemaFromXml(xmlFilePath);
    if (!fileInfo.schemaType) {
      return null;
    }

    // Try to load the schema dynamically
    return this.loadSchema(fileInfo.schemaType);
  }

  /**
   * Get schema by type name (loads on demand)
   */
  public getSchema(schemaType: string): Schema | null {
    return this.loadSchema(schemaType);
  }

  /**
   * Get all currently loaded schema types
   */
  public getAvailableSchemas(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Get all discoverable schema files in the XSD directory
   */
  public getDiscoverableSchemas(): string[] {
    try {
      const files = fs.readdirSync(this.xsdDirectory);
      return files
        .filter(file => file.endsWith('.xsd'))
        .map(file => path.basename(file, '.xsd'));
    } catch (error) {
      console.warn(`Could not read XSD directory ${this.xsdDirectory}:`, error);
      return [];
    }
  }
  /**
   * Get element definition using a specific schema by name
   * @param schemaName The schema to use
   * @param elementName The element name to find
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   */
  public getElementDefinition(schemaName: string, elementName: string, hierarchy: string[] = []): Element | undefined {
    const schema = this.loadSchema(schemaName);
    if (!schema) {
      return undefined;
    }

    return schema.getElementDefinition(elementName, hierarchy);
  }  /**
   * Get element attributes using a specific schema by name
   * @param schemaName The schema to use
   * @param elementName The element name to find
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   */
  public getElementAttributes(schemaName: string, elementName: string, hierarchy: string[] = []): { name: string; node: Element }[] {
    const schema = this.loadSchema(schemaName);
    if (!schema) {
      return [];
    }

    return schema.getElementAttributes(elementName, hierarchy);
  }  /**
   * Get element attributes with type information
   * @param schemaName The schema to use
   * @param elementName The element name to find
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   */  public getElementAttributesWithTypes(schemaName: string, elementName: string, hierarchy: string[] = []): any[] {
    const schema = this.loadSchema(schemaName);
    if (!schema) {
      return [];
    }

    return schema.getElementAttributesWithTypes(elementName, hierarchy);
  }/**
   * Validate an attribute value against the schema
   * @param schemaName The schema to use
   * @param elementName The element name
   * @param attributeName The attribute name
   * @param attributeValue The attribute value to validate
   * @param hierarchy The element hierarchy in bottom-up order (parent → root)
   */
  public validateAttributeValue(schemaName: string, elementName: string, attributeName: string, attributeValue: string, hierarchy: string[] = []): any {
    const schema = this.loadSchema(schemaName);
    if (!schema) {
      return { isValid: false, errorMessage: 'Schema not found' };
    }

    return schema.validateAttributeValue(elementName, attributeName, attributeValue, hierarchy);
  }

  /**
   * Validate XML against a specific schema by name
   */
  public validateXmlFile(xmlFilePath: string, schemaName?: string): { isValid: boolean; errors: string[] } {
    let targetSchemaName = schemaName;
      // If no schema name provided, try to detect it
    if (!targetSchemaName) {
      const fileInfo = XsdDetector.detectSchemaFromXml(xmlFilePath);
      if (!fileInfo.schemaType) {
        return {
          isValid: false,
          errors: ['Could not detect schema type for XML file']
        };
      }
      targetSchemaName = fileInfo.schemaType;
    }

    const schema = this.loadSchema(targetSchemaName);
    if (!schema) {
      return {
        isValid: false,
        errors: [`Schema '${targetSchemaName}' could not be loaded`]
      };
    }

    // Basic validation - check if file can be parsed
    try {
      const content = fs.readFileSync(xmlFilePath, 'utf8');
      const doc = new DOMParser().parseFromString(content, 'application/xml');

      // Check for parse errors
      const parseErrors = doc.getElementsByTagName('parsererror');
      if (parseErrors.length > 0) {
        return {
          isValid: false,
          errors: ['XML parse error: ' + parseErrors[0].textContent]
        };
      }

      return {
        isValid: true,
        errors: []
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Error reading/parsing XML: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Validate attributes against a list of provided attribute names
   * @param attributeInfos The attribute info array from getElementAttributesWithTypes
   * @param providedAttributes Array of attribute names that are provided
   * @returns Object containing wrong attributes and missing required attributes
   */
  public static validateAttributeNames(
    attributeInfos: any[],
    providedAttributes: string[]
  ): { wrongAttributes: string[]; missingRequiredAttributes: string[] } {
    // Get all valid attribute names from schema
    const validAttributeNames = new Set(attributeInfos.map(attr => attr.name));

    // Get required attribute names
    const requiredAttributeNames = new Set(
      attributeInfos.filter(attr => attr.required).map(attr => attr.name)
    );

    // Find wrong attributes (provided but not in schema)
    const wrongAttributes = providedAttributes.filter(attr => !validAttributeNames.has(attr));

    // Find missing required attributes (required in schema but not provided)
    const providedAttributeSet = new Set(providedAttributes);
    const missingRequiredAttributes = Array.from(requiredAttributeNames)
      .filter(attr => !providedAttributeSet.has(attr));

    return {
      wrongAttributes,
      missingRequiredAttributes
    };
  }

  /**
   * Filter attributes by type
   * @param attributeInfos The attribute info array from getElementAttributesWithTypes
   * @param attributeType The type to filter by (e.g., 'xs:string', 'xs:int', etc.)
   * @returns Array of attributes that match the specified type
   */
  public static filterAttributesByType(
    attributeInfos: any[],
    attributeType: string
  ): { name: string; node: Element }[] {
    return attributeInfos
      .filter(attr => attr.type === attributeType)
      .map(attr => ({ name: attr.name, node: attr.node }));
  }

  /**
   * Filter attributes by restriction type
   * @param attributeInfos The attribute info array from getElementAttributesWithTypes
   * @param restrictionType The restriction to filter by ('enumeration', 'pattern', 'length', 'range')
   * @returns Array of attributes that have the specified restriction type
   */
  public static filterAttributesByRestriction(
    attributeInfos: any[],
    restrictionType: 'enumeration' | 'pattern' | 'length' | 'range'
  ): { name: string; node: Element; restriction: any }[] {
    return attributeInfos
      .filter(attr => {
        switch (restrictionType) {
          case 'enumeration':
            return attr.enumValues && attr.enumValues.length > 0;
          case 'pattern':
            return attr.patterns && attr.patterns.length > 0;
          case 'length':
            return (attr.minLength !== undefined) || (attr.maxLength !== undefined);
          case 'range':
            return (attr.minInclusive !== undefined) || (attr.maxInclusive !== undefined) ||
                   (attr.minExclusive !== undefined) || (attr.maxExclusive !== undefined);
          default:
            return false;
        }
      })
      .map(attr => {
        let restriction: any = {};

        switch (restrictionType) {
          case 'enumeration':
            restriction = { enumValues: attr.enumValues };
            break;
          case 'pattern':
            restriction = { patterns: attr.patterns };
            break;
          case 'length':
            restriction = {
              minLength: attr.minLength,
              maxLength: attr.maxLength
            };
            break;
          case 'range':
            restriction = {
              minInclusive: attr.minInclusive,
              maxInclusive: attr.maxInclusive,
              minExclusive: attr.minExclusive,
              maxExclusive: attr.maxExclusive
            };
            break;
        }

        return {
          name: attr.name,
          node: attr.node,
          restriction
        };
      });
  }

  /**
   * Validate an attribute value against its schema rules
   * @param attributeInfos The attribute info array from getElementAttributesWithTypes
   * @param attributeName The attribute name to validate
   * @param attributeValue The value to validate
   * @returns Validation result with details
   */
  public static validateAttributeValueAgainstRules(
    attributeInfos: any[],
    attributeName: string,
    attributeValue: string
  ): { isValid: boolean; errorMessage?: string; violatedRules?: string[] } {
    const attribute = attributeInfos.find(attr => attr.name === attributeName);

    if (!attribute) {
      return {
        isValid: false,
        errorMessage: `Attribute '${attributeName}' not found in attribute info`
      };
    }

    const violatedRules: string[] = [];

    let isPatternsMatched = true;
    // Check patterns
    if (attribute.patterns && attribute.patterns.length > 0) {
      const patternMatches = attribute.patterns.some((pattern: string) => {
        try {
          const regex = new RegExp(pattern);
          return regex.test(attributeValue);
        } catch (e) {
          return false;
        }
      });

      if (!patternMatches) {
        isPatternsMatched = false;
        violatedRules.push(`Value must match pattern(s): ${attribute.patterns.join(' or ')}`);
      }
    }


    // Check enumeration values
    if (attribute.enumValues && attribute.enumValues.length > 0) {
      if (!attribute.enumValues.includes(attributeValue) && !isPatternsMatched) {
        violatedRules.push(`Value must be one of: ${attribute.enumValues.join(', ')}`);
      }
    }

    // Check length restrictions
    if (attribute.minLength !== undefined && attributeValue.length < attribute.minLength) {
      violatedRules.push(`Value must be at least ${attribute.minLength} characters long`);
    }

    if (attribute.maxLength !== undefined && attributeValue.length > attribute.maxLength) {
      violatedRules.push(`Value must be at most ${attribute.maxLength} characters long`);
    }

    // Check numeric range restrictions (if value is numeric)
    const numericValue = parseFloat(attributeValue);
    if (!isNaN(numericValue)) {
      if (attribute.minInclusive !== undefined && numericValue < attribute.minInclusive) {
        violatedRules.push(`Value must be >= ${attribute.minInclusive}`);
      }

      if (attribute.maxInclusive !== undefined && numericValue > attribute.maxInclusive) {
        violatedRules.push(`Value must be <= ${attribute.maxInclusive}`);
      }

      if (attribute.minExclusive !== undefined && numericValue <= attribute.minExclusive) {
        violatedRules.push(`Value must be > ${attribute.minExclusive}`);
      }

      if (attribute.maxExclusive !== undefined && numericValue >= attribute.maxExclusive) {
        violatedRules.push(`Value must be < ${attribute.maxExclusive}`);
      }
    }

    const isValid = violatedRules.length === 0;

    return {
      isValid,
      errorMessage: isValid ? undefined : violatedRules.join('; '),
      violatedRules: isValid ? undefined : violatedRules
    };
  }

  /**
   * Get possible values for an attribute if it has enumeration restrictions
   * @param attributeInfos The attribute info array from getElementAttributesWithTypes
   * @param attributeName The attribute name
   * @returns Array of possible values or empty array if no enumeration exists
   */
  public static getAttributePossibleValues(
    attributeInfos: any[],
    attributeName: string
  ): string[] {
    const attribute = attributeInfos.find(attr => attr.name === attributeName);

    if (!attribute || !attribute.enumValues) {
      return [];
    }

    return [...attribute.enumValues]; // Return a copy to prevent modification
  }

  /**
   * Get all simple types that use a specific type as their base
   * @param schemaName The schema name to search
   * @param baseType The base type to filter by (e.g., 'lvalueexpression')
   * @returns Array of simple type names that use the specified base type
   */
  public getSimpleTypesWithBaseType(
    schemaName: string,
    baseType: string
  ): string[] {
    const schema = this.loadSchema(schemaName);
    if (!schema) {
      return [];
    }

    const results: string[] = [];

    // Access the schema index to get all types
    const schemaIndex = (schema as any).schemaIndex;
    if (!schemaIndex || !schemaIndex.types) {
      return [];
    }

    // Iterate through all types and filter simple types with the specified base type
    Object.entries(schemaIndex.types).forEach(([typeName, typeNode]) => {
      const element = typeNode as Element;
      if (element.nodeName.includes('simpleType')) {
        // Look for xs:restriction element with the specified base
        const restrictions = Array.from(element.childNodes).filter(
          (node): node is Element =>
            node.nodeType === 1 &&
            (node as Element).nodeName.includes('restriction')
        );

        for (const restrictionNode of restrictions) {
          const base = restrictionNode.getAttribute('base');
          if (base === baseType) {
            results.push(typeName);
            break; // Found it, no need to check other restrictions for this type
          }
        }
      }
    });

    return results;
  }


}
