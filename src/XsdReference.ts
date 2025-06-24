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
}
