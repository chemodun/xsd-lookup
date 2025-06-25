# X4 XSD Validation System

A comprehensive TypeScript-based validation system for X4 Foundations modding tools that provides strict XSD schema validation for XML files, with support for attribute value validation, type inheritance, union types, and pattern matching.

## 🎯 Features

- **🔍 XSD-Based Validation**: Pure XSD schema validation without hardcoded logic
- **📊 Comprehensive Attribute Validation**: Validates attribute existence, types, and values
- **🔧 Infrastructure Attribute Filtering**: Automatically ignores XML namespace attributes (`xmlns`, `xmlns:*`, `xsi:*`)
- **🔗 Type Inheritance Support**: Handles complex XSD type hierarchies and restrictions
- **🔀 Union Type Processing**: Merges validation rules from multiple member types
- **📝 Pattern Validation**: Strict regex pattern matching with proper anchoring
- **📋 Enumeration Support**: Complete enumeration value extraction and validation with annotations
- **📏 Range Validation**: Numeric and length constraint validation
- **🗂️ Multi-line Normalization**: Handles multi-line XML attribute values correctly
- **📈 Performance Optimized**: Caching and indexing for fast validation
- **🧪 Extensive Testing**: Comprehensive test suite with 100% validation success

- **🔍 XSD-Based Validation**: Pure XSD schema validation without hardcoded logic
- **📊 Comprehensive Attribute Validation**: Validates attribute existence, types, and values
- **� Infrastructure Attribute Filtering**: Automatically ignores XML namespace attributes (`xmlns`, `xmlns:*`, `xsi:*`)
- **�🔗 Type Inheritance Support**: Handles complex XSD type hierarchies and restrictions
- **🔀 Union Type Processing**: Merges validation rules from multiple member types
- **📝 Pattern Validation**: Strict regex pattern matching with proper anchoring
- **📋 Enumeration Support**: Complete enumeration value extraction and validation
- **📏 Range Validation**: Numeric and length constraint validation
- **🗂️ Multi-line Normalization**: Handles multi-line XML attribute values correctly
- **📈 Performance Optimized**: Caching and indexing for fast validation
- **🧪 Extensive Testing**: Comprehensive test suite with 100% validation success

## 🚀 Quick Start

### Installation

```bash
npm install
npm run build
```

### Basic Usage

```typescript
// ES6 imports (from TypeScript/modern JavaScript)
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from './dist/XsdReference';
import { XsdDetector } from './dist/XsdDetector';

// CommonJS require (from Node.js)
const { XsdReference } = require('./dist/XsdReference');
const { XsdDetector } = require('./dist/XsdDetector');

// Initialize the validation system
const xsdRef = new XsdReference('./tests/data/xsd');

// Auto-detect schema from XML file
const schemaName = XsdDetector.getSchemaName('./my-script.xml');
const schema = xsdRef.getSchema(schemaName);

// Validate an attribute value
const result: AttributeValidationResult = schema.validateAttributeValue('do_if', 'value', 'player.money gt 1000');
console.log(result.isValid); // true/false
```

## 🔧 TypeScript Interface Exports

The package exports several TypeScript interfaces for better type safety:

```typescript
// Core attribute information interface
interface AttributeInfo {
  name: string;
  node: Element;
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

// Attribute name validation result
interface AttributeNameValidationResult {
  wrongAttributes: string[];
  missingRequiredAttributes: string[];
}
```

## 📖 API Reference

### 🏗️ Hierarchy Parameter Usage

**Important**: All methods that accept a `hierarchy` parameter expect it in **bottom-up order** (from immediate parent to root element).

#### Hierarchy Examples

```typescript
// For XML structure:
// <aiscripts>
//   <actions>
//     <do_if value="condition">
//       <debug_text text="message" />
//     </do_if>
//   </actions>
// </aiscripts>

// For 'do_if' element:
const doIfHierarchy = ['actions', 'aiscripts'];

// For 'debug_text' element:
const debugTextHierarchy = ['do_if', 'actions', 'aiscripts'];

// Usage:
const attributes = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', doIfHierarchy);
const validation = xsdRef.validateAttributeValue('aiscripts', 'debug_text', 'text', 'Hello', debugTextHierarchy);
```

### XsdReference Class

The main entry point for schema operations.

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

##### `getElementAttributes(schemaName: string, elementName: string, hierarchy?: string[]): AttributeInfo[]`

Get basic attribute information for an element.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscripts><actions><do_if>
// Hierarchy for 'do_if' element should be: ['actions', 'aiscripts']
const attributes: AttributeInfo[] = xsdRef.getElementAttributes('aiscripts', 'do_if', ['actions', 'aiscripts']);
// Returns:
// [{
//   name: 'value',
//   node: Element // DOM element reference
// }]
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
// For element structure: <aiscripts><actions><do_if>
// Hierarchy for 'do_if' element should be: ['actions', 'aiscripts']
const attributes: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);
// Returns:
// [{
//   name: 'value',
//   type: 'expression',
//   required: true,
//   patterns: ['[pattern regex]'],
//   enumValues: undefined
// }]
```

##### `validateAttributeValue(schemaName: string, elementName: string, attributeName: string, value: string, hierarchy?: string[]): AttributeValidationResult`

Validate an attribute value against XSD constraints.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscripts><actions><debug_text>
// Hierarchy for 'debug_text' element should be: ['actions', 'aiscripts']
const result: AttributeValidationResult = xsdRef.validateAttributeValue('aiscripts', 'debug_text', 'chance', '50', ['actions', 'aiscripts']);
// Returns:
// {
//   isValid: true,
//   expectedType: 'expression',
//   restrictions: ['Pattern: ...']
// }
```

##### `getElementDefinition(schemaName: string, elementName: string, hierarchy?: string[]): Element | undefined`

Get the element definition for a specific element in a schema, considering hierarchy context.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

```typescript
// For element structure: <aiscripts><actions><do_if>
// Hierarchy for 'do_if' element should be: ['actions', 'aiscripts']
const elementDef = xsdRef.getElementDefinition('aiscripts', 'do_if', ['actions', 'aiscripts']);
// Returns: Element definition object or undefined if not found
```

#### Static Methods

##### `XsdReference.validateAttributeNames(attributeInfos: EnhancedAttributeInfo[], providedAttributes: string[]): AttributeNameValidationResult`

Validate attribute names against schema definitions. This static method checks which attributes are valid and identifies missing required attributes.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) are automatically filtered out before validation.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);
const providedAttrs = ['value', 'chance', 'xmlns:xsi', 'invalid_attr'];

const nameValidation: AttributeNameValidationResult = XsdReference.validateAttributeNames(attributeInfos, providedAttrs);
// Returns:
// {
//   wrongAttributes: ['invalid_attr'],           // Infrastructure attrs filtered out
//   missingRequiredAttributes: []                // Required attributes missing
// }
// Note: 'xmlns:xsi' is ignored and doesn't appear in wrongAttributes
```

##### `XsdReference.validateAttributeValueAgainstRules(attributeInfos: EnhancedAttributeInfo[], attributeName: string, attributeValue: string)`

Validate an attribute value against all XSD rules (patterns, enumerations, ranges, etc.). This static method provides detailed validation with rule violation information.

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) are automatically ignored and always return `{ isValid: true }`.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);

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
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);

const possibleValues: Map<string, string> = XsdReference.getAttributePossibleValues(attributeInfos, 'operator');
// Returns: Map<string, string> where key is enum value, value is annotation
// Example: Map { 'eq' => 'Equal to', 'ne' => 'Not equal to', 'gt' => 'Greater than', ... }
// Returns: Map() (empty map if no enumeration exists or if it's an infrastructure attribute)

// Usage examples:
if (possibleValues.size > 0) {
  console.log('Available values:');
  for (const [value, annotation] of possibleValues) {
    console.log(`  ${value}: ${annotation || '(no description)'}`);
  }

  // Get just the values as an array
  const valueArray = Array.from(possibleValues.keys());
  console.log('Values only:', valueArray); // ['eq', 'ne', 'gt', 'ge', 'lt', 'le']
}
```

##### `XsdReference.filterAttributesByType(attributeInfos: EnhancedAttributeInfo[], attributeType: string): string[]`

Filter attributes by their XSD type (e.g., 'xs:string', 'xs:int', 'expression').

**🔧 Infrastructure Attribute Handling**: XML infrastructure attributes are automatically excluded from results.

```typescript
// Get attribute info first
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);

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
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);

const enumAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'enumeration');
// Returns: ['operator', 'type'] (example - attributes with enumeration restrictions)

const patternAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'pattern');
// Returns: ['ref', 'name'] (example - attributes with pattern restrictions)

const rangeAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'range');
// Returns: ['min', 'max'] (example - attributes with numeric range restrictions)

const lengthAttributes: string[] = XsdReference.filterAttributesByRestriction(attributeInfos, 'length');
// Returns: ['text'] (example - attributes with length restrictions)
```

#### Benefits of Static Methods

The static methods provide several advantages for validation workflows:

- **🔄 Reusable**: Can be called without creating XsdReference instances
- **⚡ Performance**: Skip schema loading when you already have attribute info
- **🎯 Granular**: Separate validation of names vs. values for better error handling
- **📋 Detailed**: Provide specific rule violation information for debugging
- **🧪 Testable**: Easy to unit test with mock attribute info data

#### Typical Validation Workflow

```typescript
// 1. Get schema and attribute info once
const xsdRef = new XsdReference('./tests/data/xsd');
const attributeInfos: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);

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
    console.log('eq annotation:', possibleValues.get('eq'));
  }
}
```

### Schema Class

Provides detailed validation capabilities for a specific XSD schema.

#### Key Methods

##### `getElementDefinition(elementName: string, hierarchy?: string[]): Element[]`

Find element definitions considering hierarchy context.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

##### `getElementAttributes(elementName: string, hierarchy?: string[])`

Get basic attribute information for an element.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

##### `validateAttributeValue(elementName: string, attributeName: string, value: string, hierarchy?: string[])`

Validate an attribute value with detailed error reporting.

**Important**: The `hierarchy` parameter should be provided in **bottom-up order** (from immediate parent to root element).

### XsdDetector Class

Automatically detects the appropriate XSD schema for XML files.

#### `getSchemaName(xmlFilePath: string): string | null`

Detect schema name from XML file path and content.

```typescript
const schemaName = XsdDetector.getSchemaName('./scripts/my-script.xml');
// Returns: 'aiscripts'
```

## 🗂️ Supported Schema Types

- **aiscripts**: AI script validation
- **md**: Mission director and macro definitions
- **common**: Shared type definitions

## � Infrastructure Attribute Handling

The validation system automatically handles XML infrastructure attributes to focus validation on content-relevant attributes:

### What are Infrastructure Attributes?

Infrastructure attributes are XML namespace and schema-related attributes that are part of the XML specification itself, not your content:

- `xmlns` - Default namespace declaration
- `xmlns:*` - Namespace prefix declarations (e.g., `xmlns:xsi`)
- `xsi:*` - XML Schema Instance attributes (e.g., `xsi:schemaLocation`)

### Automatic Filtering

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

### Benefits

- **🎯 Focus on Content**: Validation focuses on your actual XML content
- **📊 Accurate Counts**: Statistics show only content-relevant attributes
- **🔄 Compatibility**: Works seamlessly with XML files that include namespace declarations
- **⚡ Performance**: No unnecessary validation of infrastructure attributes

## �📝 Validation Features

### Attribute Type Validation

The system validates against all XSD type restrictions:

- **String patterns**: Regex pattern matching
- **Enumerations**: Exact value matching from allowed lists
- **Numeric ranges**: Min/max inclusive/exclusive constraints
- **Length constraints**: String length validation
- **Union types**: Validates against any member type
- **Type inheritance**: Follows XSD type hierarchy

### Example Validation Results

```typescript
// Valid expression
validateAttributeValue('do_if', 'value', 'player.money gt 1000')
// → { isValid: true }

// Invalid enumeration
validateAttributeValue('mission', 'type', 'invalid_type')
// → {
//   isValid: false,
//   errorMessage: "Value 'invalid_type' does not match any enumeration values",
//   allowedValues: ['missiontype.trade', 'missiontype.fight', ...]
// }

// Pattern mismatch
validateAttributeValue('handler', 'ref', "value'with'quotes")
// → {
//   isValid: false,
//   errorMessage: "Value does not match required pattern: [^']*"
// }
```

## 🧪 Testing

### Run Comprehensive Tests

```bash
# Run all XML files validation
npm test

# Build and test in one command
npm run test:full

# Build TypeScript files
npm run build
```

### Test Results Format

```text
📄 Testing: order.dock.xml
   Schema detected: aiscripts
   Elements found: 803
   Attributes found: 1220        # Content attributes only (infrastructure filtered)
   ✅ Elements valid: 803/803
   ✅ Attributes valid: 1220/1220
   ✅ Attribute values valid: 1220/1220
```

Green checkmarks (✅) appear only when valid count equals total count.

**Note**: Attribute counts exclude XML infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) to provide accurate content validation statistics.

## 🏗️ Architecture

### Core Components

```text
XsdReference
├── Schema (per XSD file)
│   ├── SchemaIndex (elements, types, groups)
│   ├── HierarchyCache (performance optimization)
│   └── Validation Engine
├── XsdDetector (auto-detection)
└── Test Suite (comprehensive validation)
```

### Validation Flow

1. **Schema Detection**: Auto-detect or specify XSD schema
2. **Element Resolution**: Find element definition in schema hierarchy (using bottom-up hierarchy order)
3. **Attribute Lookup**: Get attribute definitions with type information
4. **Type Resolution**: Follow type inheritance and union types
5. **Value Validation**: Apply all XSD constraints (patterns, enums, ranges)
6. **Result Generation**: Detailed validation results with error context

## 🚀 Performance

- **Cached Schema Parsing**: XSD files parsed once and cached
- **Hierarchical Indexing**: Fast element/attribute lookups
- **Optimized Type Resolution**: Efficient inheritance chain traversal
- **Pattern Compilation**: Regex patterns compiled and cached

### Benchmark Results

- **2,134 elements** validated successfully
- **3,389 attributes** with values validated
- **100% success rate** on real X4 XML files
- **3,018 pattern validations** passed
- **137 enumeration validations** passed

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

### Adding New Validation Rules

The system automatically discovers and applies XSD validation rules. To add support for new XSD features:

1. Update `getTypeValidationInfo()` in `src/Schema.ts`
2. Add extraction logic for new XSD restriction types
3. Update `validateBasicType()` to handle new validation logic
4. Add test cases to verify new functionality

## 📋 Validation Types Supported

### XSD Simple Type Restrictions

- ✅ **xs:enumeration** - Exact value matching
- ✅ **xs:pattern** - Regex pattern validation
- ✅ **xs:minLength/maxLength** - String length constraints
- ✅ **xs:minInclusive/maxInclusive** - Numeric range validation
- ✅ **xs:minExclusive/maxExclusive** - Exclusive numeric ranges
- ✅ **xs:union** - Union type validation (any member type)
- ✅ **xs:restriction** - Type inheritance and refinement

### XML Features

- ✅ **Multi-line attributes** - Normalized before validation
- ✅ **XML namespaces** - Infrastructure attributes (`xmlns`, `xmlns:*`, `xsi:*`) automatically filtered from validation
- ✅ **Element hierarchy** - Context-aware element resolution
- ✅ **Schema includes** - Automatic XSD include resolution

## 🎮 X4 Modding Integration

### Supported File Types

- **AI Scripts** (`.xml` in aiscripts folders)
- **Mission Director** (`.xml` in md folders)
- **Macro Definitions** (using md schema)
- **Component Libraries** (using common schema)

### Example Use Cases

- **Script Validation**: Validate AI scripts before game testing
- **IDE Integration**: Real-time validation in code editors
- **Build Pipelines**: Automated validation in mod build processes
- **Documentation**: Generate attribute references from XSD

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add comprehensive tests for new functionality
4. Ensure all existing tests pass
5. Submit a pull request

### Testing Guidelines

- Add test cases for new validation features
- Test against real X4 XML files in `tests/data/`
- Maintain 100% validation success rate
- Update comprehensive test suite when adding new features

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **X4 Foundations** by Egosoft for the complex and rich modding system
- **XML Schema (XSD)** specification for comprehensive validation standards
- **TypeScript** and **Node.js** ecosystem for excellent development tools

---

## 🔍 Quick Reference

### Common Validation Patterns

```typescript
// Check if attribute has enumerations
const attributes: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('aiscripts', 'do_if', ['actions', 'aiscripts']);
const attr = attributes.find(a => a.name === 'type');
if (attr && attr.enumValues?.length > 0) {
  console.log('Valid values:', attr.enumValues);
}

// Get all possible values for an enumeration attribute
const possibleValues: Map<string, string> = XsdReference.getAttributePossibleValues(attributes, 'operator');
console.log('Possible values:', Array.from(possibleValues.keys())); // ['eq', 'ne', 'gt', 'ge', 'lt', 'le']

// Check individual values and their annotations
if (possibleValues.has('eq')) {
  console.log('eq means:', possibleValues.get('eq') || '(no description)');
}

// Convert to array if needed for compatibility
const valuesArray: string[] = Array.from(possibleValues.keys());

// Filter attributes by restriction type
const enumAttrs: string[] = XsdReference.filterAttributesByRestriction(attributes, 'enumeration');
const patternAttrs: string[] = XsdReference.filterAttributesByRestriction(attributes, 'pattern');
console.log('Enum attributes:', enumAttrs);
console.log('Pattern attributes:', patternAttrs);

// Validate with detailed error info (remember: hierarchy in bottom-up order)
const hierarchy: string[] = ['actions', 'aiscripts']; // parent -> root
const result: AttributeValidationResult = schema.validateAttributeValue('do_if', 'value', 'condition', hierarchy);
if (!result.isValid) {
  console.error('Validation failed:', result.errorMessage);
  if (result.allowedValues) {
    console.log('Allowed:', result.allowedValues);
  }
}

// Infrastructure attributes are automatically handled
const allAttrs = ['value', 'chance', 'xmlns:xsi', 'xsi:schemaLocation'];
const nameValidation: AttributeNameValidationResult = XsdReference.validateAttributeNames(attributes, allAttrs);
// Infrastructure attributes won't appear in wrongAttributes

// Get all validation constraints (remember: hierarchy in bottom-up order)
const attrs: EnhancedAttributeInfo[] = xsdRef.getElementAttributesWithTypes('do_if', ['actions', 'aiscripts']);
attrs.forEach(attr => {
  console.log(`${attr.name}: ${attr.type}`);
  console.log(`  Required: ${attr.required}`);
  console.log(`  Patterns: ${attr.patterns?.length || 0}`);
  console.log(`  Enums: ${attr.enumValues?.length || 0}`);
});
```

### Available Commands

```bash
# Build TypeScript code
npm run build

# Run tests (requires built code)
npm test

# Build and test in one command
npm run test:full

# Clean compiled output
npm run clean

# Clean and rebuild
npm run rebuild
```

🎯 **Ready to validate your X4 mods with confidence!**
