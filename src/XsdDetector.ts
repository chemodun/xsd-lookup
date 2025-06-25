import * as fs from 'fs';
import * as path from 'path';
import { DOMParser } from '@xmldom/xmldom';

export interface XmlFileInfo {
  schemaType: string | null;
  schemaFile: string | null;
}

/**
 * Utility class for detecting XSD schema types from XML files
 */
export class XsdDetector {
  /**
   * Detect the schema type from XML file header
   */
  public static detectSchemaFromXml(xmlFilePath: string): XmlFileInfo {
    try {
      const content = fs.readFileSync(xmlFilePath, 'utf8');

      // Look for xsi:noNamespaceSchemaLocation attribute
      const schemaLocationMatch = content.match(/xsi:noNamespaceSchemaLocation\s*=\s*["']([^"']+)["']/);

      if (schemaLocationMatch) {
        const schemaFile = schemaLocationMatch[1];
        // Extract schema name without extension
        const schemaType = path.basename(schemaFile, '.xsd');
        return { schemaType, schemaFile };
      }

      // Fallback: detect by root element and map to known schema names
      const doc = new DOMParser().parseFromString(content, 'application/xml');
      const rootElement = doc.documentElement;

      if (rootElement) {
        const rootName = rootElement.nodeName;
        // Common mapping for backward compatibility
        if (rootName === 'aiscript') {
          return { schemaType: 'aiscripts', schemaFile: 'aiscripts.xsd' };
        } else if (rootName === 'mdscript') {
          return { schemaType: 'md', schemaFile: 'md.xsd' };
        }

        // For unknown root elements, try to use the root name as schema type
        const possibleSchemaType = rootName.toLowerCase();
        return { schemaType: possibleSchemaType, schemaFile: `${possibleSchemaType}.xsd` };
      }

      return { schemaType: null, schemaFile: null };
    } catch (error) {
      console.error(`Error detecting schema for ${xmlFilePath}:`, error);
      return { schemaType: null, schemaFile: null };
    }
  }

  /**
   * Convenience function to get just the schema name
   */
  public static getSchemaName(xmlFilePath: string): string | null {
    const info = this.detectSchemaFromXml(xmlFilePath);
    return info.schemaType;
  }
}
