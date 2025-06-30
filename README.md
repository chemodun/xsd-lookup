# XSD schema validation for XML nodes, attributes and values

A comprehensive TypeScript-based XSD schema validation system for XML files, which provides nodes, attributes, and values validation against XSD schemas, including the strict hierarchical dependencies.

Developed to support scripting language validation in **X4: Foundations** game modding, but can be used for any XML validation needs, based on XSD schemas.

## 🎯 Features

- **🔍 XSD-Based Validation**: Pure XSD schema validation without hardcoded logic
- **📊 Comprehensive Attribute Validation**: Validates attribute existence, types, and values
- **🔧 Infrastructure Attribute Filtering**: Automatically ignores XML namespace attributes (`xmlns`, `xmlns:*`, `xsi:*`)
- **🔗 Type Inheritance Support**: Handles complex XSD type hierarchies and restrictions
- **🔀 Union Type Processing**: Merges validation rules from multiple member types
- **📋 Enumeration Support**: Complete enumeration value extraction and validation with annotations
- **📏 Range Validation**: Numeric and length constraint validation
- **🗂️ Multi-line Normalization**: Handles multi-line XML attribute values correctly
- **📈 Performance Optimized**: Caching and indexing for fast validation

## 🚀 Quick Start

### Installation

```powershell
npm install xsd_lookup --save
```

### Basic Usage

```typescript
// ES6 imports (from TypeScript/modern JavaScript)
import { XsdReference } from 'xsd_lookup';

// Initialize the validation system
const xsdRef = new XsdReference('./tests/data/xsd');
const elementName = 'set_value';
const elementHierarchy = ['actions', 'attention', 'aiscript']; // Please pay attention to the hierarchy order, it should be bottom-up (from immediate parent to root element)

const elementDefinition = xsdRef.getElementDefinition(elementName, elementHierarchy);
console.log(`Element ${elementName} is ${elementDefinition ? 'defined' : 'not defined'} in the schema.`);

const elementAttributes = xsdRef.getElementAttributesWithTypes(elementName, elementHierarchy);
console.log(`Element ${elementName} has ${elementAttributes.length} attributes.`);

const attributeValues = xsdRef.getAttributePossibleValues(elementAttributes, 'operation');
console.log(`Possible values for 'operation': ${Array.from(attributeValues.keys()).join(', ')}`);

const checkAttributeValue = xsdRef.validateAttributeValueAgainstRules(elementAttributes, 'operation', 'unknown');
console.log(`Attribute 'operation' value 'unknown' is ${checkAttributeValue.isValid ? 'valid' : 'invalid'}.`);

// Clean up resources when done (optional but recommended)
xsdRef.dispose();
```

## 📖 API Reference

### 🏷️ Type Definitions

#### Exported Interfaces

```typescript
// Basic attribute information
export interface AttributeInfo {
  name: string;
  node: Element; // DOM element reference
}

// Enhanced attribute information with validation rules
interface EnhancedAttributeInfo {
  name: string;
  type: string;
  required: boolean;
  patterns?: string[];
  enumValues?: string[];
  enumValuesAnnotations?: Map<string, string>;
  minLength?: number;
  maxLength?: number;
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
}

// Attribute validation result
interface AttributeValidationResult {
  isValid: boolean;
  errorMessage?: string;
  expectedType?: string;
  restrictions?: string[];
  allowedValues?: string[];
}
```

### 🏷️ Input parameters

- `schemaName`: Name of the schema to operate on (e.g., 'aiscripts'). Equal to the XSD file name without extension.
- `elementName`: Name of the XML element to validate (e.g., 'do_if').
- `attributeName`: Name of the attribute to validate (e.g., 'value').
- `value`: The value to validate against the attribute's XSD rules (e.g., 'player.money gt 1000').
- `hierarchy`: Parameter to specify the hierarchy of elements in bottom-up order (from immediate parent to root element) in XML-file. This is crucial for correct validation context.

#### 🏗️ Hierarchy Parameter Usage

**Important**: All methods that accept a `hierarchy` parameter expect it in **bottom-up order** (from immediate parent to root element).

##### Hierarchy Examples

```typescript
// For XML structure:
// <aiscript>
//   <attention>
//     <actions>
//       <do_if value="$condition">
//         <debug_text text="message" />
//       </do_if>
//     <set_value name="$value" exact="100" />
//     </actions>
//   </attention>
// </aiscript>

// For 'do_if' element:
const doIfHierarchy = ['actions', 'attention', 'aiscript'];

// For 'debug_text' element:
const debugTextHierarchy = ['do_if', 'actions', 'attention', 'aiscript'];

// Usage:
const attributes = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', doIfHierarchy);
const validation = xsdRef.validateAttributeValue('aiscripts', 'debug_text', 'text', 'Hello', debugTextHierarchy);
```

### XsdReference Class

The main entry point for any operations.

#### Constructor

```typescript
new XsdReference(xsdDirectory: string)
```

#### Core Methods

##### `getSchema(schemaName: string): Schema | null`

Load and return a schema by name.

```typescript
const schema = xsdRef.getSchema('aiscripts');
```

##### `getAvailableSchemas(): string[]`

Get all currently loaded schema types.

```typescript
const loadedSchemas: string[] = xsdRef.getAvailableSchemas();
// Returns: ['aiscripts', 'md'] (schemas that are currently loaded in memory)
```

##### `getDiscoverableSchemas(): string[]`

Get all discoverable schema files in the XSD directory.

```typescript
const availableSchemas: string[] = xsdRef.getDiscoverableSchemas();
// Returns: ['aiscripts', 'common', 'md'] (all .xsd files found in directory, without extension)
```

##### `getElementDefinition(schemaName: string, elementName: string, hierarchy?: string[]): Element | undefined`

Get the element definition for a specific element in a schema, considering hierarchy context.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscript><attention><actions><set_value>
// Hierarchy for 'set_value' element should be: ['actions', 'attention', 'aiscript']
const elementDef = xsdRef.getElementDefinition('aiscripts', 'set_value', ['actions', 'attention', 'aiscript']);
// Returns: Element definition object or undefined if not found
```

##### `getElementAttributes(schemaName: string, elementName: string, hierarchy?: string[]): AttributeInfo[]`

Get basic attribute information for an element.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscript><attention><actions><set_value>
// Hierarchy for 'set_value' element should be: ['actions', 'attention', 'aiscript']
const attributes: AttributeInfo[] = xsdRef.getElementAttributes('aiscripts', 'set_value', ['actions', 'attention', 'aiscript']);
// Returns:
// [{
//   name: 'name',
//   node: Element // DOM element reference
// },
// {
//   name: 'value',
//   node: Element // DOM element reference
// },
// ...]
```

##### `getElementAttributesWithTypes(schemaName: string, elementName: string, hierarchy?: string[]): EnhancedAttributeInfo[]`

Get all attributes for an element with complete type information including:

- Type name
- Required status
- Enumeration values (if applicable)
- Pattern restrictions
- Numeric/length constraints

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscript><attention><actions><do_if>
// Hierarchy for 'do_if' element should be: ['actions', 'attention', 'aiscript']
const attributes: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);
// Returns:
// [{
//   name: 'value',
//   type: 'expression',
//   required: true,
//   patterns: ['[pattern regex]'],
//   enumValues: undefined
// }
// ...]
```

##### `validateAttributeValue(schemaName: string, elementName: string, attributeName: string, value: string, hierarchy?: string[]): AttributeValidationResult`

Validate an attribute value against XSD constraints.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscript><attention><actions><do_if><debug_text>
// Hierarchy for 'debug_text' element should be: ['do_if', 'actions', 'attention', 'aiscript']
const result: AttributeValidationResult = xsdRef.validateAttributeValue('aiscript', 'debug_text', 'chance', '50', ['do_if', 'actions', 'attention', 'aiscript']);
// Returns:
// {
//   isValid: true,
//   expectedType: 'expression',
//   restrictions: ['Pattern: ...']
// }
```

##### `getPossibleChildElements(schemaName: string, elementName: string, hierarchy?: string[]): Map<string, string>`

Get possible child elements for a given element, with their annotation text.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscript><attention><actions>
// Get possible children of 'actions' element
const children: Map<string, string> = xsdRef.getPossibleChildElements('aiscripts', 'actions', ['attention', 'aiscript']);
// Returns: Map where key is child element name, value is annotation text
// Example: Map { 'do_if' => 'Conditional execution', 'do_while' => 'Loop execution', ... }

// Usage examples:
if (children.size > 0) {
  console.log('Possible child elements:');
  for (const [elementName, annotation] of children) {
    console.log(`  ${elementName}: ${annotation || '(no description)'}`);
  }
}
```

##### `getSimpleTypesWithBaseType(schemaName: string, baseType: string): string[]`

Get all simple types that use a specific type as their base.

```typescript
// Find all simple types based on 'lvalueexpression'
const derivedTypes: string[] = xsdRef.getSimpleTypesWithBaseType('aiscripts', 'lvalueexpression');
// Returns: ['expression', 'objectref', 'paramname', ...] (types that extend lvalueexpression)

// Find all types based on xs:string
const stringTypes: string[] = xsdRef.getSimpleTypesWithBaseType('common', 'xs:string');
// Returns: ['name', 'comment', 'text', ...] (string-based types)
```

##### `dispose(): void`

Clear all internal caches to release resources.

```typescript
// Get a schema instance
const schema = xsdRef.getSchema('aiscripts');

// Use the schema for validation...
const result = schema.validateAttributeValue('do_if', 'value', 'condition');

// Clean up schema resources when done
schema.dispose();
```

**Note**: Not recommended for frequent use in performance-sensitive scenarios.

#### Static Methods

##### `XsdReference.validateAttributeNames(attributeInfos: EnhancedAttributeInfo[], providedAttributes: string[]): AttributeNameValidationResult`

Validate attribute names against schema definitions. This static method checks which attributes are valid and identifies missing required attributes.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) are automatically filtered out before validation.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);
const providedAttrs = ['value', 'chance', 'xmlns:xsi', 'invalid_attr'];

const nameValidation: AttributeNameValidationResult = XsdReference.validateAttributeNames(attributeInfos, providedAttrs);
// Returns:
// {
//   wrongAttributes: ['invalid_attr'],           // Infrastructure attrs filtered out
//   missingRequiredAttributes: ['negate', ...]                // Required attributes missing
// }
// Note: 'xmlns:xsi' is ignored and doesn't appear in wrongAttributes
```

##### `XsdReference.validateAttributeValueAgainstRules(attributeInfos: EnhancedAttributeInfo[], attributeName: string, attributeValue: string)`

Validate an attribute value against all XSD rules (patterns, enumerations, ranges, etc.). This static method provides detailed validation with rule violation information.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) are automatically ignored and always return `{ isValid: true }`.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);

const valueValidation = XsdReference.validateAttributeValueAgainstRules(
  attributeInfos,
  'value',
  'player.money gt 1000'
);
// Returns:
// {
//   isValid: true,
//   errorMessage: undefined,        // Only present if invalid
//   violatedRules: undefined        // Only present if invalid - array of specific rule violations
// }

// Example with invalid value:
const invalidValidation = XsdReference.validateAttributeValueAgainstRules(
  attributeInfos,
  'chance',
  '150'
);
// Returns:
// {
//   isValid: false,
//   errorMessage: "Value must be <= 100",
//   violatedRules: ["Value must be <= 100"]
// }

// Infrastructure attributes are ignored:
const infraValidation = XsdReference.validateAttributeValueAgainstRules(
  attributeInfos,
  'xmlns:xsi',
  'http://www.w3.org/2001/XMLSchema-instance'
);
// Returns:
// {
//   isValid: true
// }
```

##### `XsdReference.getAttributePossibleValues(attributeInfos: EnhancedAttributeInfo[], attributeName: string): Map<string, string>`

Get all possible enumeration values for an attribute, if it has enumeration restrictions.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes always return an empty Map.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'set_value', ['actions', 'attention', 'aiscript']);

const possibleValues: Map<string, string> = XsdReference.getAttributePossibleValues(attributeInfos, 'operator');
// Returns: Map<string, string> where key is enum value, value is annotation
// Example: Map { 'set' => 'Set value', 'add' => 'Add to value', 'subtract' => 'Subtract from value', ... }
// Returns: Map() (empty map if no enumeration exists or if it's an infrastructure attribute)

// Usage examples:
if (possibleValues.size > 0) {
  console.log('Available values:');
  for (const [value, annotation] of possibleValues) {
    console.log(`  ${value}: ${annotation || '(no description)'}`);
  }

  // Get just the values as an array
  const valueArray = Array.from(possibleValues.keys());
  console.log('Values only:', valueArray); // ['set', 'add', 'subtract', 'insert']
}
```

##### `XsdReference.filterAttributesByType(attributeInfos: EnhancedAttributeInfo[], attributeType: string): string[]`

Filter attributes by their XSD type (e.g., 'xs:string', 'xs:int', 'expression').

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes are automatically excluded from results.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);

const stringAttributes: string[] = XsdReference.filterAttributesByType(attributeInfos, 'xs:string');
// Returns: ['comment', 'name'] (example - attributes with xs:string type)

const expressionAttributes: string[] = XsdReference.filterAttributesByType(attributeInfos, 'expression');
// Returns: ['value', 'chance'] (example - attributes with expression type)
```

##### `XsdReference.filterAttributesByRestriction(attributeInfos: EnhancedAttributeInfo[], restrictionType: 'enumeration' | 'pattern' | 'length' | 'range'): string[]`

Filter attributes by the type of XSD restriction they have.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes are automatically excluded from results.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);

const enumAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'enumeration');
// Returns: ['operator', 'type'] (example - attributes with enumeration restrictions)

const patternAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'pattern');
// Returns: ['ref', 'name'] (example - attributes with pattern restrictions)

const rangeAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'range');
// Returns: ['min', 'max'] (example - attributes with numeric range restrictions)

const lengthAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'length');
// Returns: ['text'] (example - attributes with length restrictions)
```

##### `XsdReference.extractAnnotationText(element: Element): string | undefined`

Extract annotation text from an XML element. This provides access to Schema's annotation extraction functionality.

```typescript
// This is typically used internally, but can be useful for custom schema processing
const element: Element = /* DOM element from XSD */;
const annotation: string | undefined = XsdReference.extractAnnotationText(element);
// Returns: "Description text from xs:annotation/xs:documentation" or undefined

// Example usage with element definitions:
const elementDef = xsdRef.getElementDefinition('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);
if (elementDef) {
  const description = XsdReference.extractAnnotationText(elementDef);
  console.log('Element description:', description || 'No description available');
}
```

#### Typical Validation Workflow

```typescript
// 1. Get schema and attribute info once
const xsdRef = new XsdReference('./tests/data/xsd');
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'attention', 'aiscript']);

// 2. Validate attribute names (fast, no schema lookup needed)
// Infrastructure attributes (xmlns, xsi:) are automatically filtered out
const nameValidation: AttributeNameValidationResult = XsdReference.validateAttributeNames(attributeInfos, ['value', 'xmlns:xsi', 'invalid_attr']);
if (nameValidation.wrongAttributes.length > 0) {
  console.error('Invalid attributes:', nameValidation.wrongAttributes); // Only shows 'invalid_attr'
}

// 3. Validate attribute values (fast, no schema lookup needed)
// Infrastructure attributes automatically return { isValid: true }
for (const attrName of validAttributes) {
  const valueValidation = XsdReference.validateAttributeValueAgainstRules(
    attributeInfos,
    attrName,
    attributeValue
  );
  if (!valueValidation.isValid) {
    console.error(`Invalid value for ${attrName}:`, valueValidation.violatedRules);
  }
}

// 4. Use helper methods to analyze attributes by type or restriction
const enumAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'enumeration');
const possibleValues: Map<string, string> = XsdReference.getAttributePossibleValues(attributeInfos, 'operator');

// Work with possible values Map
if (possibleValues.size > 0) {
  console.log('Operator values:', Array.from(possibleValues.keys()));
  // Check if a specific value is valid
  if (possibleValues.has('eq')) {
    console.log('eq annotation:', possibleValues.get('eq') || '(no description)');
  }
}
```

### Schema Class

There is a main engine for validating XML files against XSD schemas. It provides detailed validation capabilities for a specific XSD schema.

**Note**: Not recommended to use directly, prefer using `XsdReference` for schema management.

### XsdDetector Class

Automatically detects the appropriate XSD schema for XML files.

#### `getSchemaName(xmlFilePath: string): string | null`

Detect schema name from XML file path and content.

```typescript
const schemaName = XsdDetector.getSchemaName('./scripts/my-script.xml');
// Returns: 'aiscripts'
```

### � Infrastructure Attribute Handling

The validation system automatically handles XML infrastructure attributes to focus validation on content-relevant attributes:

#### What are Infrastructure Attributes?

Infrastructure attributes are XML namespace and schema-related attributes that are part of the XML specification itself, not your content:

- `xmlns` - Default namespace declaration
- `xmlns:*` - Namespace prefix declarations (e.g., `xmlns:xsi`)
- `xsi:*` - XML Schema Instance attributes (e.g., `xsi:schemaLocation`)

#### Automatic Filtering

All static validation methods automatically filter out infrastructure attributes:

```xml
<!-- Example XML with infrastructure attributes -->
<do_if value="player.money gt 1000"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xsi:schemaLocation="..."
       chance="50">
  <!-- content -->
</do_if>
```

```typescript
// Only 'value' and 'chance' are validated; xmlns/xsi attributes are ignored
const attributeInfos = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', hierarchy);
const nameValidation = XsdReference.validateAttributeNames(
  attributeInfos,
  ['value', 'chance', 'xmlns:xsi', 'xsi:schemaLocation']
);
// Result: { wrongAttributes: [], missingRequiredAttributes: [] }
// Infrastructure attributes don't appear in wrongAttributes

const valueValidation = XsdReference.validateAttributeValueAgainstRules(
  attributeInfos,
  'xmlns:xsi',
  'http://www.w3.org/2001/XMLSchema-instance'
);
// Result: { isValid: true } - Infrastructure attributes always pass
```

## 🔧 Development

### Project Structure

```text
├── src/                   # TypeScript source files
│   ├── Schema.ts          # Core validation engine
│   ├── XsdReference.ts    # Main API interface
│   └── XsdDetector.ts     # Schema auto-detection
├── dist/                  # Compiled JavaScript output
├── tests/                 # Comprehensive test suite
│   ├── data/              # Test data and schemas
│   │   ├── xsd/           # XSD schema definitions
│   │   ├── aiscripts/     # AI script test files
│   │   └── md/            # Mission director test files
│   └── test_all_files_comprehensive.js
├── package.json           # Project configuration
└── tsconfig.json          # TypeScript configuration
```

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **X4 Foundations** by Egosoft for the complex and rich modding system
- **XML Schema (XSD)** specification for comprehensive validation standards
- **TypeScript** and **Node.js** ecosystem for excellent development tools

### Performance Tips

- Reuse `XsdReference` instances when validating multiple files with the same schemas
- Call `dispose()` only when completely finished with validation tasks
- Use static methods (`XsdReference.validateAttributeNames`, etc.) for batch operations with pre-fetched attribute info
