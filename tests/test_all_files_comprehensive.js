const { XsdReference } = require('../dist/XsdReference');
const { XsdDetector } = require('../dist/XsdDetector');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

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

// JUnit XML test results tracking
let testSuites = [];
let testStartTime = new Date();

/**
 * Create a test result directory if it doesn't exist
 */
function ensureTestResultsDirectory() {
  const testResultsDir = path.join(__dirname, '..', 'test-results');
  if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
  }
  return testResultsDir;
}

/**
 * Escape XML special characters
 */
function escapeXml(unsafe) {
  if (typeof unsafe !== 'string') {
    unsafe = String(unsafe);
  }
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
    }
  });
}

/**
 * Generate JUnit XML output for test results with comprehensive validation details
 */
function generateJUnitXML() {
  const testResultsDir = ensureTestResultsDirectory();
  const xmlPath = path.join(testResultsDir, 'test-results.xml');

  const totalTestsCount = testSuites.reduce((sum, suite) => sum + suite.tests, 0);
  const totalFailuresCount = testSuites.reduce((sum, suite) => sum + suite.failures, 0);
  const totalErrorsCount = testSuites.reduce((sum, suite) => sum + suite.errors, 0);
  const totalTime = (new Date() - testStartTime) / 1000;

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<testsuites name="XSD Validation Tests" tests="${totalTestsCount}" failures="${totalFailuresCount}" errors="${totalErrorsCount}" time="${totalTime.toFixed(3)}">\n`;

  // Add global properties with comprehensive test statistics
  xml += '  <properties>\n';
  xml += `    <property name="total_files_processed" value="${totalFiles}" />\n`;
  xml += `    <property name="valid_files" value="${validFiles}" />\n`;
  xml += `    <property name="file_success_rate" value="${totalFiles > 0 ? ((validFiles / totalFiles) * 100).toFixed(1) : 0}%" />\n`;
  xml += `    <property name="total_elements_validated" value="${totalElements}" />\n`;
  xml += `    <property name="valid_elements" value="${validElements}" />\n`;
  xml += `    <property name="element_success_rate" value="${totalElements > 0 ? ((validElements / totalElements) * 100).toFixed(1) : 0}%" />\n`;
  xml += `    <property name="total_attributes_validated" value="${totalAttributes}" />\n`;
  xml += `    <property name="valid_attributes" value="${validAttributes}" />\n`;
  xml += `    <property name="attribute_success_rate" value="${totalAttributes > 0 ? ((validAttributes / totalAttributes) * 100).toFixed(1) : 0}%" />\n`;
  xml += `    <property name="total_attribute_values_validated" value="${totalAttributeValues}" />\n`;
  xml += `    <property name="valid_attribute_values" value="${validAttributeValues}" />\n`;
  xml += `    <property name="attribute_value_success_rate" value="${totalAttributeValues > 0 ? ((validAttributeValues / totalAttributeValues) * 100).toFixed(1) : 0}%" />\n`;
  xml += `    <property name="pattern_validations_tested" value="${patternValidationStats.tested}" />\n`;
  xml += `    <property name="pattern_validations_passed" value="${patternValidationStats.passed}" />\n`;
  xml += `    <property name="enumeration_validations_tested" value="${enumValidationStats.tested}" />\n`;
  xml += `    <property name="enumeration_validations_passed" value="${enumValidationStats.passed}" />\n`;
  xml += `    <property name="loaded_schemas" value="${xsdRef.getAvailableSchemas().join(', ')}" />\n`;
  xml += `    <property name="total_errors_found" value="${errors.length}" />\n`;
  xml += '  </properties>\n';

  for (const suite of testSuites) {
    xml += `  <testsuite name="${escapeXml(suite.name)}" tests="${suite.tests}" failures="${suite.failures}" errors="${suite.errors}" time="${suite.time.toFixed(3)}" timestamp="${suite.timestamp}">\n`;

    // Add properties section with suite-level statistics
    xml += '    <properties>\n';
    if (suite.properties) {
      for (const [key, value] of Object.entries(suite.properties)) {
        xml += `      <property name="${escapeXml(key)}" value="${escapeXml(String(value))}" />\n`;
      }
    }
    xml += '    </properties>\n';

    for (const testCase of suite.testCases) {
      xml += `    <testcase name="${escapeXml(testCase.name)}" classname="${escapeXml(suite.name)}" time="${testCase.time.toFixed(3)}"`;

      if (testCase.failure || testCase.error || testCase.systemOut || testCase.systemErr) {
        xml += '>\n';

        // Add failure information
        if (testCase.failure) {
          xml += `      <failure message="${escapeXml(testCase.failure.message)}" type="${escapeXml(testCase.failure.type)}">${escapeXml(testCase.failure.details)}</failure>\n`;
        }

        // Add error information
        if (testCase.error) {
          xml += `      <error message="${escapeXml(testCase.error.message)}" type="${escapeXml(testCase.error.type)}">${escapeXml(testCase.error.details)}</error>\n`;
        }

        // Add system-out for validation details (similar to console output)
        if (testCase.systemOut) {
          xml += `      <system-out><![CDATA[${testCase.systemOut}]]></system-out>\n`;
        }

        // Add system-err for warnings and non-fatal issues
        if (testCase.systemErr) {
          xml += `      <system-err><![CDATA[${testCase.systemErr}]]></system-err>\n`;
        }

        xml += '    </testcase>\n';
      } else {
        // Add system-out even for successful tests to show validation details
        if (testCase.systemOut) {
          xml += '>\n';
          xml += `      <system-out><![CDATA[${testCase.systemOut}]]></system-out>\n`;
          xml += '    </testcase>\n';
        } else {
          xml += ' />\n';
        }
      }
    }

    xml += '  </testsuite>\n';
  }

  xml += '</testsuites>\n';

  fs.writeFileSync(xmlPath, xml, 'utf8');
  console.log(`\n📊 JUnit XML test results written to: ${xmlPath}`);
}

/**
 * Parse XML file and extract all elements with their full hierarchy and attribute values
 */
function extractElementsFromXml(xmlContent, filePath) {
  try {
    const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');
    const elements = [];

    function walkElements(node, hierarchyPath = [], previousSibling = null) {
      if (!node || node.nodeType !== 1) return;

      const elementName = node.nodeName;
      const currentHierarchy = [...hierarchyPath];

      elements.push({
        name: elementName,
        hierarchy: currentHierarchy,
        // Keep old format for compatibility
        parent: hierarchyPath.length > 0 ? hierarchyPath[hierarchyPath.length - 1] : null,
        grandparent: hierarchyPath.length > 1 ? hierarchyPath[hierarchyPath.length - 2] : null,
        previousSibling: previousSibling,
        attributes: getElementAttributes(node),
        attributeValues: getElementAttributeValues(node)
      });

      // Recurse into children with updated hierarchy
      const newHierarchy = [...hierarchyPath, elementName];
      let lastElementName = null;
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          walkElements(child, newHierarchy, lastElementName);
          lastElementName = child.nodeName;
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

  // Convert top-down hierarchy (from XML parsing) to bottom-up hierarchy (expected by XsdReference)
  const bottomUpHierarchy = [...hierarchy].reverse();

  // Use the bottom-up hierarchy for validation
  const elementDef = xsdRef.getElementDefinition(schemaName, name, bottomUpHierarchy);
  results.elementValid = elementDef !== undefined;
  if (!results.elementValid) {
    const errorMsg = `Element '${name}' not found in schema`;
    const errorDetails = `Hierarchy: [${bottomUpHierarchy.join(' > ')}], File: ${filePath}`;
    throw new Error(`${errorMsg}. ${errorDetails}`);
  }

  // Additional validation: ensure this element is allowed under its parent
  const parentName = elementInfo.parent;
  if (parentName) {
    const parentBottomUp = bottomUpHierarchy.slice(1); // parent's own bottom-up hierarchy (its parents only)
    const prev = elementInfo.previousSibling || undefined;
    const allowedChildren = xsdRef.isValidChild(schemaName, name, parentName, parentBottomUp, prev);
    if (!allowedChildren) {
      const where = `parent: '${parentName}'` + (prev ? `, previous sibling: '${prev}'` : ', first child');
      const errorMsg = `Element '${name}' is not allowed here under ${where}`;
      const errorDetails = `Parent hierarchy: [${parentBottomUp.join(' > ')}], File: ${filePath}`;
      throw new Error(`${errorMsg}. ${errorDetails}`);
    }
  }

  // Get comprehensive attribute information including validation rules
  const schemaAttributes = xsdRef.getElementAttributesWithTypes(schemaName, name, bottomUpHierarchy);

  // Use the static method to validate attribute names
  const nameValidation = XsdReference.validateAttributeNames(schemaAttributes, attributes);

  // Handle wrong attributes (attributes not in schema)
  if (nameValidation.wrongAttributes.length > 0) {
    results.invalidAttributes.push(...nameValidation.wrongAttributes);

    for (const attr of nameValidation.wrongAttributes) {
      results.attributeValidationDetails.push({
        name: attr,
        status: 'invalid_attribute',
        value: attributeValues?.[attr],
        error: 'Attribute not defined in schema'
      });

      // Throw error instead of process.exit(1)
      const errorMsg = `Element '${name}' has invalid attribute '${attr}'`;
      const errorDetails = `Hierarchy: [${bottomUpHierarchy.join(' > ')}], Valid attributes: ${schemaAttributes.map(a => a.name).join(', ')}, All element attributes: ${attributes.join(', ')}, Attribute value: '${attributeValues?.[attr] || ''}', File: ${filePath}`;
      throw new Error(`${errorMsg}. ${errorDetails}`);
    }
  }

  // Handle missing required attributes
  if (nameValidation.missingRequiredAttributes.length > 0) {
    for (const attr of nameValidation.missingRequiredAttributes) {
      const errorMsg = `Element '${name}' is missing required attribute '${attr}'`;
      const errorDetails = `Hierarchy: [${bottomUpHierarchy.join(' > ')}], File: ${filePath}`;
      throw new Error(`${errorMsg}. ${errorDetails}`);
    }
  }

  // Process valid attributes and validate their values
  for (const attr of attributes) {
    if (!nameValidation.wrongAttributes.includes(attr)) {
      results.validAttributes.push(attr);

      // Get detailed attribute info
      const attrInfo = schemaAttributes.find(a => a.name === attr);
      const value = (attributeValues && attributeValues[attr] !== undefined) ? attributeValues[attr] : '';

      // Use the static method to validate attribute value against rules
      const valueValidation = XsdReference.validateAttributeValueAgainstRules(schemaAttributes, attr, value);

      const validationDetail = {
        name: attr,
        type: attrInfo?.type || 'unknown',
        required: attrInfo?.required || false,
        patterns: attrInfo?.patterns || [],
        enumValues: attrInfo?.enumValues || [],
        value: value || '(empty)',
        valueValid: valueValidation.isValid,
        status: valueValidation.isValid ? 'valid_value' : 'invalid_value'
      };

      if (!valueValidation.isValid) {
        validationDetail.error = valueValidation.errorMessage;

        results.invalidAttributeValues.push({
          attribute: attr,
          value: value,
          error: valueValidation.errorMessage,
          type: attrInfo?.type,
          patterns: attrInfo?.patterns,
          enumValues: attrInfo?.enumValues
        });

        // Throw error instead of process.exit(1)
        const errorMsg = `Element '${name}' attribute '${attr}' has invalid value '${value}'`;
        let errorDetails = `Hierarchy: [${bottomUpHierarchy.join(' > ')}], Attribute type: ${attrInfo?.type || 'unknown'}, Error: ${valueValidation.errorMessage}`;

        if (valueValidation.violatedRules) {
          errorDetails += `, Violated rules: ${valueValidation.violatedRules.join('; ')}`;
        }
        errorDetails += `, File: ${filePath}`;

        throw new Error(`${errorMsg}. ${errorDetails}`);
      }

      results.attributeValidationDetails.push(validationDetail);
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

  const suiteStartTime = new Date();
  const testSuite = {
    name: `${dirInfo.name} Directory Validation`,
    tests: 0,
    failures: 0,
    errors: 0,
    time: 0,
    timestamp: suiteStartTime.toISOString(),
    testCases: []
  };

  if (!fs.existsSync(dirInfo.path)) {
    console.log(`❌ Directory not found: ${dirInfo.path}`);

    // Add error test case for missing directory
    testSuite.testCases.push({
      name: `Directory Exists: ${dirInfo.path}`,
      time: 0,
      error: {
        message: `Directory not found: ${dirInfo.path}`,
        type: 'DirectoryNotFoundError',
        details: `The test directory ${dirInfo.path} does not exist`
      }
    });
    testSuite.tests = 1;
    testSuite.errors = 1;
    testSuite.time = (new Date() - suiteStartTime) / 1000;
    testSuites.push(testSuite);
    return;
  }

  // Read all files in directory
  const files = fs.readdirSync(dirInfo.path)
    .filter(file => file.endsWith('.xml'))
    .sort();

  console.log(`Found ${files.length} XML files\n`);  for (const fileName of files) {
    const filePath = path.join(dirInfo.path, fileName);
    console.log(`📄 Testing: ${fileName}`);

    const testCaseStartTime = new Date();
    const testCase = {
      name: `File Validation: ${fileName}`,
      time: 0,
      failure: null,
      error: null,
      systemOut: '', // Will contain detailed validation information
      systemErr: ''  // Will contain warnings and non-fatal issues
    };

    // Build detailed output similar to console
    let validationOutput = [];
    let warningOutput = [];

    totalFiles++;

    try {
      // Read and parse XML content
      const xmlContent = fs.readFileSync(filePath, 'utf8');

      // Detect schema
      const detectedSchemaName = XsdDetector.getSchemaName(filePath);
      console.log(`   Schema detected: ${detectedSchemaName}`);
      validationOutput.push(`📋 Schema detected: ${detectedSchemaName}`);

      if (!detectedSchemaName) {
        console.log(`   ❌ Could not detect schema for ${fileName}`);
        errors.push(`${fileName}: Could not detect schema`);

        testCase.failure = {
          message: `Could not detect schema for ${fileName}`,
          type: 'SchemaDetectionFailure',
          details: `Failed to detect appropriate XSD schema for file ${fileName}`
        };
        testCase.systemOut = validationOutput.join('\n');
        testSuite.failures++;
        testCase.time = (new Date() - testCaseStartTime) / 1000;
        testSuite.testCases.push(testCase);
        testSuite.tests++;
        continue;
      }

      // Validate schema detection
      if (detectedSchemaName !== dirInfo.expectedSchema) {
        console.log(`   ⚠️  Expected ${dirInfo.expectedSchema}, got ${detectedSchemaName}`);
        warningOutput.push(`⚠️ Expected schema: ${dirInfo.expectedSchema}, got: ${detectedSchemaName}`);
      }

      // Extract all elements from the XML
      const xmlElements = extractElementsFromXml(xmlContent, filePath);
      console.log(`   Elements found: ${xmlElements.length}`);
      validationOutput.push(`🔧 Elements found: ${xmlElements.length}`);

      // Count all attributes found in the XML (excluding XML namespace attributes)
      const totalAttributesInFile = xmlElements.reduce((sum, elem) => {
        return sum + elem.attributes.filter(attr => {
          // Filter out XML namespace attributes from the count
          return !(attr.startsWith('xmlns:') || attr.startsWith('xsi:') || attr === 'xmlns');
        }).length;
      }, 0);
      console.log(`   Attributes found: ${totalAttributesInFile}`);
      validationOutput.push(`⚙️ Attributes found: ${totalAttributesInFile}`);

      let fileElementsValid = 0;
      let fileAttributesValid = 0;
      let fileAttributesTotal = 0;
      let fileAttributeValuesValid = 0;
      let fileAttributeValuesTotal = 0;
      let fileValidationErrors = [];
      let elementValidationDetails = [];

      // Validate each element
      for (const elementInfo of xmlElements) {
        totalElements++;

        try {
          const validation = validateElement(detectedSchemaName, elementInfo, filePath);

          if (validation.elementValid) {
            validElements++;
            fileElementsValid++;
          } else {
            const errorMsg = `Element '${elementInfo.name}' not found in schema (parent: ${elementInfo.parent})`;
            errors.push(`${fileName}: ${errorMsg}`);
            fileValidationErrors.push(errorMsg);
          }

          // Capture detailed validation information for this element
          const elementDetail = {
            element: elementInfo.name,
            hierarchy: elementInfo.hierarchy,
            attributeCount: validation.attributeValidationDetails.length,
            validAttributes: validation.validAttributes.length,
            invalidAttributes: validation.invalidAttributes.length,
            validationDetails: validation.attributeValidationDetails
          };
          elementValidationDetails.push(elementDetail);

          // Track attributes with comprehensive validation details
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
          validAttributes += elementValidAttrs;

          // Track comprehensive validation statistics
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
            }

            // Track pattern validation
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
            }

            // Count valid attribute values (all defined attributes, not just those with values)
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
            const errorMsg = `Element '${elementInfo.name}' has invalid attributes: ${validation.invalidAttributes.join(', ')}`;
            errors.push(`${fileName}: ${errorMsg}`);
            fileValidationErrors.push(errorMsg);
          }

          // Report invalid attribute values
          if (validation.invalidAttributeValues.length > 0) {
            validation.invalidAttributeValues.forEach(invalidValue => {
              const errorMsg = `Element '${elementInfo.name}' attribute '${invalidValue.attribute}' has invalid value '${invalidValue.value}': ${invalidValue.error}`;
              errors.push(`${fileName}: ${errorMsg}`);
              fileValidationErrors.push(errorMsg);
            });
          }
        } catch (elementError) {
          // Catch validation errors that would cause process.exit(1)
          const errorMsg = `Validation error for element '${elementInfo.name}': ${elementError.message}`;
          errors.push(`${fileName}: ${errorMsg}`);
          fileValidationErrors.push(errorMsg);
        }
      }

      // Add detailed validation summary to output
      const elementsStatus = fileElementsValid === xmlElements.length ? '✅' : '❌';
      const attributesStatus = fileAttributesValid === fileAttributesTotal ? '✅' : '❌';
      const attributeValuesStatus = fileAttributeValuesValid === fileAttributeValuesTotal ? '✅' : '❌';

      console.log(`   ${elementsStatus} Elements valid: ${fileElementsValid}/${xmlElements.length}`);
      console.log(`   ${attributesStatus} Attributes valid: ${fileAttributesValid}/${fileAttributesTotal}`);
      console.log(`   ${attributeValuesStatus} Attribute values valid: ${fileAttributeValuesValid}/${fileAttributeValuesTotal}`);

      validationOutput.push(`${elementsStatus} Elements validation: ${fileElementsValid}/${xmlElements.length}`);
      validationOutput.push(`${attributesStatus} Attributes validation: ${fileAttributesValid}/${fileAttributesTotal}`);
      validationOutput.push(`${attributeValuesStatus} Attribute values validation: ${fileAttributeValuesValid}/${fileAttributeValuesTotal}`);      // Add detailed breakdown of elements and their validation status
      if (elementValidationDetails.length > 0) {
        validationOutput.push('\n📋 Element Validation Details:');
        elementValidationDetails.slice(0, 10).forEach(detail => { // Limit to first 10 for readability
          const status = detail.validAttributes === detail.attributeCount ? '✅' : '❌';
          validationOutput.push(`  ${status} ${detail.element}: ${detail.validAttributes}/${detail.attributeCount} attributes valid`);

          // Add attribute-level details for failed validations
          if (detail.invalidAttributes > 0) {
            const invalidDetails = detail.validationDetails.filter(v => !v.valueValid);
            invalidDetails.slice(0, 3).forEach(invalid => { // Limit to 3 per element
              validationOutput.push(`    ❌ ${invalid.name}: ${invalid.error || 'Invalid'}`);
            });
          }
        });

        if (elementValidationDetails.length > 10) {
          validationOutput.push(`  ... and ${elementValidationDetails.length - 10} more elements`);
        }
      }

      // Add detailed validation statistics to XML output
      validationOutput.push('\n📊 Validation Statistics:');
      validationOutput.push(`🎯 Pattern Validation: ${patternValidationStats.tested} tested, ${patternValidationStats.passed} passed, ${patternValidationStats.failed} failed`);
      validationOutput.push(`📋 Enumeration Validation: ${enumValidationStats.tested} tested, ${enumValidationStats.passed} passed, ${enumValidationStats.failed} failed`);

      // Add attribute type distribution for this file
      const fileAttributeTypes = {};
      elementValidationDetails.forEach(detail => {
        detail.validationDetails.forEach(attr => {
          if (attr.type && attr.type !== 'unknown') {
            fileAttributeTypes[attr.type] = (fileAttributeTypes[attr.type] || 0) + 1;
          }
        });
      });

      if (Object.keys(fileAttributeTypes).length > 0) {
        validationOutput.push('\n🔧 Attribute Types in File:');
        const sortedTypes = Object.entries(fileAttributeTypes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5); // Top 5 types
        sortedTypes.forEach(([type, count]) => {
          validationOutput.push(`  ${type}: ${count} attributes`);
        });
        if (Object.keys(fileAttributeTypes).length > 5) {
          validationOutput.push(`  ... and ${Object.keys(fileAttributeTypes).length - 5} more types`);
        }
      }

      // Add final summary for this file
      validationOutput.push('\n🎯 File Validation Summary:');
      validationOutput.push(`📁 File: ${fileName}`);
      validationOutput.push(`📋 Schema: ${detectedSchemaName}`);
      validationOutput.push(`🔧 Elements: ${xmlElements.length} (${fileElementsValid} valid)`);
      validationOutput.push(`⚙️ Attributes: ${fileAttributesTotal} (${fileAttributesValid} valid)`);
      validationOutput.push(`🔍 Attribute Values: ${fileAttributeValuesTotal} (${fileAttributeValuesValid} valid)`);
      validationOutput.push(`❌ Validation Errors: ${fileValidationErrors.length}`);

      if (fileValidationErrors.length > 0) {
        validationOutput.push('\n❌ Errors Found:');
        fileValidationErrors.slice(0, 5).forEach(error => {
          validationOutput.push(`  ${error}`);
        });
        if (fileValidationErrors.length > 5) {
          validationOutput.push(`  ... and ${fileValidationErrors.length - 5} more errors`);
        }
      }

      // Determine test case result
      if (fileValidationErrors.length > 0) {
        testCase.failure = {
          message: `Validation failed for ${fileName}`,
          type: 'ValidationFailure',
          details: fileValidationErrors.join('\n')
        };
        testSuite.failures++;
      } else if (fileElementsValid === xmlElements.length &&
          fileAttributesValid === fileAttributesTotal &&
          fileAttributeValuesValid === fileAttributeValuesTotal) {
        validFiles++;
      }

    } catch (error) {
      console.log(`   ❌ Error processing ${fileName}:`, error.message);
      const errorMsg = `Processing error - ${error.message}`;
      errors.push(`${fileName}: ${errorMsg}`);

      testCase.error = {
        message: `Error processing ${fileName}`,
        type: 'ProcessingError',
        details: error.message
      };
      testSuite.errors++;
    }

    // Store the detailed output in the test case
    testCase.systemOut = validationOutput.join('\n');
    if (warningOutput.length > 0) {
      testCase.systemErr = warningOutput.join('\n');
    }

    testCase.time = (new Date() - testCaseStartTime) / 1000;
    testSuite.testCases.push(testCase);
    testSuite.tests++;
    console.log();
  }

  testSuite.time = (new Date() - suiteStartTime) / 1000;

  // Add suite-level properties with summary statistics
  const suiteElementsTotal = testSuite.testCases.reduce((sum, tc) => {
    const match = tc.systemOut.match(/🔧 Elements found: (\d+)/);
    return sum + (match ? parseInt(match[1]) : 0);
  }, 0);

  const suiteAttributesTotal = testSuite.testCases.reduce((sum, tc) => {
    const match = tc.systemOut.match(/⚙️ Attributes found: (\d+)/);
    return sum + (match ? parseInt(match[1]) : 0);
  }, 0);

  testSuite.properties = {
    'total_xml_files': testSuite.tests,
    'total_elements_validated': suiteElementsTotal,
    'total_attributes_validated': suiteAttributesTotal,
    'validation_success_rate': testSuite.failures === 0 ? '100%' : `${((testSuite.tests - testSuite.failures) / testSuite.tests * 100).toFixed(1)}%`,
    'expected_schema': dirInfo.expectedSchema
  };

  testSuites.push(testSuite);
}

// Run tests for all directories
for (const dirInfo of testDirs) {
  testDirectory(dirInfo);
}

// Generate JUnit XML test results
generateJUnitXML();

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

try {
  // Dispose the XSD reference to release resources
  xsdRef.dispose();
}
catch (error) {
  console.error('Error disposing XSD reference:', error);
}

// Final assessment
if (validFiles === totalFiles && errors.length === 0) {
  console.log('🏆 PERFECT SCORE: All files pass validation!');
  process.exit(0);
} else if (validFiles / totalFiles > 0.9) {
  console.log('✅ EXCELLENT: Most files pass validation');
  process.exit(0);
} else if (validFiles / totalFiles > 0.7) {
  console.log('⚠️  GOOD: Majority of files pass validation');
  process.exit(0);
} else {
  console.log('❌ NEEDS ATTENTION: Many validation issues found');
  process.exit(1);
}
