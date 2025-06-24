const { XsdReference } = require('../dist/XsdReference') || require('./dist/XsdReference.js');
const { XsdDetector } = require('../dist/XsdDetector') || require('./dist/XsdDetector.js');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('xmldom');

console.log('=== Comprehensive All-Files XSD Validation Test ===\n');

// Initialize the new TypeScript system (XSD directory is now in tests/data/xsd)
const xsdRef = new XsdReference(path.join(__dirname, 'data', 'xsd'));

// Define test directories
const testDirs = [
  { name: 'Scripts', path: path.join(__dirname, 'data', 'aiscripts'), expectedSchema: 'aiscripts' },
  { name: 'MD', path: path.join(__dirname, 'data', 'md'), expectedSchema: 'md' }
];

// Stats tracking
let totalFiles = 0;
let validFiles = 0;
let totalElements = 0;
let validElements = 0;
let totalAttributes = 0;
let validAttributes = 0;
let totalAttributeValues = 0;
let validAttributeValues = 0;
let attributeTypeStats = {};
let patternValidationStats = { tested: 0, passed: 0, failed: 0 };
let enumValidationStats = { tested: 0, passed: 0, failed: 0 };
let errors = [];

/**
 * Parse XML file and extract all elements with their full hierarchy and attribute values
 */
function extractElementsFromXml(xmlContent, filePath) {
  try {
    const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');
    const elements = [];

    function walkElements(node, hierarchyPath = []) {
      if (!node || node.nodeType !== 1) return;

      const elementName = node.nodeName;
      const currentHierarchy = [...hierarchyPath];

      elements.push({
        name: elementName,
        hierarchy: currentHierarchy,
        // Keep old format for compatibility
        parent: hierarchyPath.length > 0 ? hierarchyPath[hierarchyPath.length - 1] : null,
        grandparent: hierarchyPath.length > 1 ? hierarchyPath[hierarchyPath.length - 2] : null,
        attributes: getElementAttributes(node),
        attributeValues: getElementAttributeValues(node)
      });

      // Recurse into children with updated hierarchy
      const newHierarchy = [...hierarchyPath, elementName];
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          walkElements(child, newHierarchy);
        }
      }
    }

    function getElementAttributes(element) {
      const attrs = [];
      if (element.attributes) {
        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i];
          attrs.push(attr.name);
        }
      }
      return attrs;
    }

    function getElementAttributeValues(element) {
      const attrValues = {};
      if (element.attributes) {
        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i];
          attrValues[attr.name] = attr.value;
        }
      }
      return attrValues;
    }

    walkElements(doc.documentElement);
    return elements;
  } catch (error) {
    console.error(`Error parsing XML ${filePath}:`, error);
    return [];
  }
}

/**
 * Validate an element against the schema with comprehensive attribute value validation
 */
function validateElement(schemaName, elementInfo, filePath) {
  const { name, hierarchy, attributes, attributeValues } = elementInfo;
  const results = {
    elementValid: false,
    validAttributes: [],
    invalidAttributes: [],
    invalidAttributeValues: [],
    attributeValidationDetails: []
  };

  // Use the full hierarchy for validation
  const elementDefs = xsdRef.getElementDefinition(schemaName, name, hierarchy);
  results.elementValid = elementDefs.length > 0;

  if (!results.elementValid) {
    console.error(`❌ VALIDATION FAILED: Element '${name}' not found in schema`);
    console.error(`   Hierarchy: [${hierarchy.join(' > ')}]`);
    console.error(`   File: ${filePath}`);
    process.exit(1); // Fail immediately
  }

  // Get comprehensive attribute information including validation rules
  const schemaAttributes = xsdRef.getElementAttributesWithTypes(schemaName, name, hierarchy);
  const validAttributeNames = schemaAttributes.map(attr => attr.name);

  // Filter out XML namespace attributes (these are XML infrastructure, not schema-defined)
  const isXmlNamespaceAttribute = (attrName) => {
    return attrName.startsWith('xmlns:') ||
           attrName.startsWith('xsi:') ||
           attrName === 'xmlns';
  };

  // Validate each attribute existence and value with detailed reporting
  for (const attr of attributes) {
    if (isXmlNamespaceAttribute(attr)) {
      // Skip XML namespace attributes - they're infrastructure, not schema-defined
      results.validAttributes.push(attr);
      results.attributeValidationDetails.push({
        name: attr,
        status: 'skipped',
        reason: 'XML namespace attribute'
      });
    } else if (validAttributeNames.includes(attr)) {
      results.validAttributes.push(attr);

      // Get detailed attribute info for enhanced validation
      const attrInfo = schemaAttributes.find(a => a.name === attr);
      const validationDetail = {
        name: attr,
        type: attrInfo?.type || 'unknown',
        required: attrInfo?.required || false,
        patterns: attrInfo?.patterns || [],
        enumValues: attrInfo?.enumValues || [],
        status: 'valid'
      };      // Validate attribute value (all defined attributes should be validated)
      const value = (attributeValues && attributeValues[attr] !== undefined) ? attributeValues[attr] : '';
      const valueValidation = xsdRef.validateAttributeValue(schemaName, name, attr, value, hierarchy);

      validationDetail.value = value || '(empty)';
      validationDetail.valueValid = valueValidation.isValid;

      if (!valueValidation.isValid) {
        validationDetail.status = 'invalid_value';
        validationDetail.error = valueValidation.errorMessage;

        results.invalidAttributeValues.push({
          attribute: attr,
          value: value,
          error: valueValidation.errorMessage,
          type: attrInfo?.type,
          patterns: attrInfo?.patterns,
          enumValues: attrInfo?.enumValues
        });

        // FAIL IMMEDIATELY on invalid attribute values with enhanced error info
        console.error(`❌ ATTRIBUTE VALUE VALIDATION FAILED: Element '${name}' attribute '${attr}' has invalid value '${value}'`);
        console.error(`   Hierarchy: [${hierarchy.join(' > ')}]`);
        console.error(`   Attribute type: ${attrInfo?.type || 'unknown'}`);
        console.error(`   Error: ${valueValidation.errorMessage}`);

        if (attrInfo?.enumValues && attrInfo.enumValues.length > 0) {
          console.error(`   Allowed values: ${attrInfo.enumValues.join(', ')}`);
        }

        if (attrInfo?.patterns && attrInfo.patterns.length > 0) {
          console.error(`   Required pattern(s):`);
          attrInfo.patterns.forEach((pattern, index) => {
            console.error(`     Pattern ${index + 1}: ${pattern}`);
          });
        }

        if (attrInfo?.minLength !== undefined || attrInfo?.maxLength !== undefined) {
          console.error(`   Length constraints: min=${attrInfo.minLength || 'none'}, max=${attrInfo.maxLength || 'none'}`);
        }
        if (attrInfo?.minInclusive !== undefined || attrInfo?.maxInclusive !== undefined) {
          console.error(`   Numeric range: min=${attrInfo.minInclusive || 'none'}, max=${attrInfo.maxInclusive || 'none'}`);
        }

        console.error(`   File: ${filePath}`);
        process.exit(1); // Fail immediately
      } else {
        validationDetail.status = 'valid_value';
      }

      results.attributeValidationDetails.push(validationDetail);
    } else {
      results.invalidAttributes.push(attr);

      results.attributeValidationDetails.push({
        name: attr,
        status: 'invalid_attribute',
        value: attributeValues?.[attr],
        error: 'Attribute not defined in schema'
      });

      // FAIL IMMEDIATELY on invalid attributes with enhanced error info
      console.error(`❌ ATTRIBUTE VALIDATION FAILED: Element '${name}' has invalid attribute '${attr}'`);
      console.error(`   Hierarchy: [${hierarchy.join(' > ')}]`);
      console.error(`   Valid attributes: ${validAttributeNames.join(', ')}`);
      console.error(`   All element attributes: ${attributes.join(', ')}`);
      console.error(`   Attribute value: '${attributeValues?.[attr] || ''}'`);
      console.error(`   File: ${filePath}`);
      process.exit(1); // Fail immediately
    }
  }

  return results;
}

/**
 * Test all XML files in a directory
 */
function testDirectory(dirInfo) {
  console.log(`\n=== Testing ${dirInfo.name} Directory ===`);
  console.log(`Path: ${dirInfo.path}`);

  if (!fs.existsSync(dirInfo.path)) {
    console.log(`❌ Directory not found: ${dirInfo.path}`);
    return;
  }

  // Read all files in directory
  const files = fs.readdirSync(dirInfo.path)
    .filter(file => file.endsWith('.xml'))
    .sort();

  console.log(`Found ${files.length} XML files\n`);

  for (const fileName of files) {
    const filePath = path.join(dirInfo.path, fileName);
    console.log(`📄 Testing: ${fileName}`);

    totalFiles++;

    try {
      // Read and parse XML content
      const xmlContent = fs.readFileSync(filePath, 'utf8');

      // Detect schema
      const detectedSchemaName = XsdDetector.getSchemaName(filePath);
      console.log(`   Schema detected: ${detectedSchemaName}`);

      if (!detectedSchemaName) {
        console.log(`   ❌ Could not detect schema for ${fileName}`);
        errors.push(`${fileName}: Could not detect schema`);
        continue;
      }

      // Validate schema detection
      if (detectedSchemaName !== dirInfo.expectedSchema) {
        console.log(`   ⚠️  Expected ${dirInfo.expectedSchema}, got ${detectedSchemaName}`);
      }      // Extract all elements from the XML
      const xmlElements = extractElementsFromXml(xmlContent, filePath);
      console.log(`   Elements found: ${xmlElements.length}`);
        // Count all attributes found in the XML (excluding XML namespace attributes)
      const totalAttributesInFile = xmlElements.reduce((sum, elem) => {
        return sum + elem.attributes.filter(attr => {
          // Filter out XML namespace attributes from the count
          return !(attr.startsWith('xmlns:') || attr.startsWith('xsi:') || attr === 'xmlns');
        }).length;
      }, 0);
      console.log(`   Attributes found: ${totalAttributesInFile}`);let fileElementsValid = 0;
      let fileAttributesValid = 0;
      let fileAttributesTotal = 0;
      let fileAttributeValuesValid = 0;
      let fileAttributeValuesTotal = 0;

      // Validate each element
      for (const elementInfo of xmlElements) {
        totalElements++;

        const validation = validateElement(detectedSchemaName, elementInfo, filePath);

        if (validation.elementValid) {
          validElements++;
          fileElementsValid++;
        } else {
          errors.push(`${fileName}: Element '${elementInfo.name}' not found in schema (parent: ${elementInfo.parent})`);
        }        // Track attributes with comprehensive validation details
        // Count only non-XML namespace attributes for both total and valid counts
        const elementTotalAttrs = validation.attributeValidationDetails.filter(detail => detail.status !== 'skipped').length;
        const elementValidAttrs = validation.validAttributes.filter(attr => {
          // Check if this attribute was skipped by looking in validation details
          const detail = validation.attributeValidationDetails.find(d => d.name === attr);
          return detail?.status !== 'skipped';
        }).length;

        fileAttributesTotal += elementTotalAttrs;
        fileAttributesValid += elementValidAttrs;
        totalAttributes += elementTotalAttrs;
        validAttributes += elementValidAttrs;// Track comprehensive validation statistics
        for (const detail of validation.attributeValidationDetails) {
          // Count file-level attribute values (all defined attributes, not just those with values)
          if (detail.status !== 'skipped') { // Skip XML namespace attributes
            fileAttributeValuesTotal++;
            if (detail.valueValid) {
              fileAttributeValuesValid++;
            }
          }

          // Track attribute types
          if (detail.type && detail.type !== 'unknown') {
            attributeTypeStats[detail.type] = (attributeTypeStats[detail.type] || 0) + 1;
          }          // Track pattern validation
          if (detail.patterns && detail.patterns.length > 0 && detail.status !== 'skipped') {
            patternValidationStats.tested++;
            if (detail.valueValid) {
              patternValidationStats.passed++;
            } else {
              patternValidationStats.failed++;
            }
          }

          // Track enumeration validation
          if (detail.enumValues && detail.enumValues.length > 0 && detail.status !== 'skipped') {
            enumValidationStats.tested++;
            if (detail.valueValid) {
              enumValidationStats.passed++;
            } else {
              enumValidationStats.failed++;
            }
          }          // Count valid attribute values (all defined attributes, not just those with values)
          if (detail.status !== 'skipped' && detail.valueValid) {
            validAttributeValues++;
          }

          // Count all attribute values we validated
          if (detail.status !== 'skipped') {
            totalAttributeValues++;
          }
        }

        // Report invalid attributes
        if (validation.invalidAttributes.length > 0) {
          errors.push(`${fileName}: Element '${elementInfo.name}' has invalid attributes: ${validation.invalidAttributes.join(', ')}`);
        }

        // Report invalid attribute values
        if (validation.invalidAttributeValues.length > 0) {
          validation.invalidAttributeValues.forEach(invalidValue => {
            errors.push(`${fileName}: Element '${elementInfo.name}' attribute '${invalidValue.attribute}' has invalid value '${invalidValue.value}': ${invalidValue.error}`);
          });
        }
      }      console.log(`   ${fileElementsValid === xmlElements.length ? '✅' : '❌'} Elements valid: ${fileElementsValid}/${xmlElements.length}`);
      console.log(`   ${fileAttributesValid === fileAttributesTotal ? '✅' : '❌'} Attributes valid: ${fileAttributesValid}/${fileAttributesTotal}`);
      console.log(`   ${fileAttributeValuesValid === fileAttributeValuesTotal ? '✅' : '❌'} Attribute values valid: ${fileAttributeValuesValid}/${fileAttributeValuesTotal}`);      if (fileElementsValid === xmlElements.length &&
          fileAttributesValid === fileAttributesTotal &&
          fileAttributeValuesValid === fileAttributeValuesTotal) {
        validFiles++;
      }

    } catch (error) {
      console.log(`   ❌ Error processing ${fileName}:`, error.message);
      errors.push(`${fileName}: Processing error - ${error.message}`);
    }

    console.log();
  }
}

// Run tests for all directories
for (const dirInfo of testDirs) {
  testDirectory(dirInfo);
}

// Print summary
console.log('\n' + '='.repeat(60));
console.log('📊 COMPREHENSIVE TEST SUMMARY');
console.log('='.repeat(60));

console.log(`\n📁 Files Processed:`);
console.log(`   Total files: ${totalFiles}`);
console.log(`   Valid files: ${validFiles}`);
console.log(`   Success rate: ${totalFiles > 0 ? ((validFiles / totalFiles) * 100).toFixed(1) : 0}%`);

console.log(`\n🔧 Elements Validated:`);
console.log(`   Total elements: ${totalElements}`);
console.log(`   Valid elements: ${validElements}`);
console.log(`   Success rate: ${totalElements > 0 ? ((validElements / totalElements) * 100).toFixed(1) : 0}%`);

console.log(`\n⚙️  Attributes Validated:`);
console.log(`   Total attributes: ${totalAttributes}`);
console.log(`   Valid attributes: ${validAttributes}`);
console.log(`   Success rate: ${totalAttributes > 0 ? ((validAttributes / totalAttributes) * 100).toFixed(1) : 0}%`);

console.log(`\n🔍 Attribute Value Validation:`);
console.log(`   Total attribute values: ${totalAttributeValues}`);
console.log(`   Valid attribute values: ${validAttributeValues}`);
console.log(`   Success rate: ${totalAttributeValues > 0 ? ((validAttributeValues / totalAttributeValues) * 100).toFixed(1) : 0}%`);

console.log(`\n🎯 Pattern Validation:`);
console.log(`   Patterns tested: ${patternValidationStats.tested}`);
console.log(`   Pattern validations passed: ${patternValidationStats.passed}`);
console.log(`   Pattern validations failed: ${patternValidationStats.failed}`);
console.log(`   Pattern success rate: ${patternValidationStats.tested > 0 ? ((patternValidationStats.passed / patternValidationStats.tested) * 100).toFixed(1) : 0}%`);

console.log(`\n📋 Enumeration Validation:`);
console.log(`   Enumerations tested: ${enumValidationStats.tested}`);
console.log(`   Enumeration validations passed: ${enumValidationStats.passed}`);
console.log(`   Enumeration validations failed: ${enumValidationStats.failed}`);
console.log(`   Enumeration success rate: ${enumValidationStats.tested > 0 ? ((enumValidationStats.passed / enumValidationStats.tested) * 100).toFixed(1) : 0}%`);

console.log(`\n📊 Attribute Type Distribution:`);
const typeEntries = Object.entries(attributeTypeStats).sort((a, b) => b[1] - a[1]);
if (typeEntries.length > 0) {
  typeEntries.slice(0, 10).forEach(([type, count]) => {
    console.log(`   ${type}: ${count} attributes`);
  });
  if (typeEntries.length > 10) {
    console.log(`   ... and ${typeEntries.length - 10} more types`);
  }
} else {
  console.log(`   No typed attributes found`);
}

console.log(`\n📈 Schema Status:`);
console.log(`   Loaded schemas: ${xsdRef.getAvailableSchemas().join(', ')}`);
console.log(`   Discoverable schemas: ${xsdRef.getDiscoverableSchemas().join(', ')}`);

if (errors.length > 0) {
  console.log(`\n❌ ERRORS FOUND (${errors.length}):`);
  errors.slice(0, 20).forEach(error => console.log(`   ${error}`));
  if (errors.length > 20) {
    console.log(`   ... and ${errors.length - 20} more errors`);
  }
} else {
  console.log(`\n✅ NO ERRORS FOUND!`);
}

console.log('\n' + '='.repeat(60));
console.log('🎯 TEST COMPLETE');
console.log('='.repeat(60));

// Final assessment
if (validFiles === totalFiles && errors.length === 0) {
  console.log('🏆 PERFECT SCORE: All files pass validation!');
} else if (validFiles / totalFiles > 0.9) {
  console.log('✅ EXCELLENT: Most files pass validation');
} else if (validFiles / totalFiles > 0.7) {
  console.log('⚠️  GOOD: Majority of files pass validation');
} else {
  console.log('❌ NEEDS ATTENTION: Many validation issues found');
}
