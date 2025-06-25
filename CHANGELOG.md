# Changelog

## [1.2.3](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.2.2...xsd-lookup@v1.2.3) (2025-06-25)


### Bug Fixes

* postfix after the replace xmldom with @xmldom/xmldom and remove deprecated types dependency ([d5fb181](https://github.com/chemodun/xsd-lookup/commit/d5fb181d97962b9fda642fe345e85cdd95253dc9))
* update node engine requirement to &gt;= 22.0.0 in package.json and package-lock.json ([afcb1d5](https://github.com/chemodun/xsd-lookup/commit/afcb1d520b563bd386cfb455f212795dc2daa043))

## [1.2.2](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.2.1...xsd-lookup@v1.2.2) (2025-06-25)

### Bug Fixes

* update xmldom dependency to @xmldom/xmldom version 0.8.10 to solve dependabot alerts ([288adfa](https://github.com/chemodun/xsd-lookup/commit/288adfa625c337ad4b2cd2b02702dc6d1f51d02c))

## [1.2.1](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.2.0...xsd-lookup@v1.2.1) (2025-06-25)

### Code Refactoring

* Added new caching mechanism for element definitions in Schema to optimize lookups. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Enhance Schema and XsdReference for improved attribute handling and validation ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Implemented utility functions to handle XML infrastructure attributes, ensuring they are ignored during validation. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Introduced EnhancedAttributeInfo interface to include additional validation details and annotations for attributes. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Refactored XsdReference to support EnhancedAttributeInfo and added methods for validating attribute names and filtering attributes. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Updated comprehensive tests to reflect changes in attribute validation and filtering logic. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))
* Updated methods in Schema to utilize the new EnhancedAttributeInfo, including getElementAttributesWithTypes and validateValueWithRestrictions. ([557ea38](https://github.com/chemodun/xsd-lookup/commit/557ea381f20dd601a727b232a02da344ca424cac))

### Miscellaneous Chores

* Implement comprehensive JUnit XML reporting for XSD validation tests ([4de81ae](https://github.com/chemodun/xsd-lookup/commit/4de81aec940438ad14775d75b6d7aa41cdc658f5))

## [1.2.0](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.1.1...xsd-lookup@v1.2.0) (2025-06-24)

### Features

* add static validation methods for attribute names and values in XsdReference class ([2fa7f0a](https://github.com/chemodun/xsd-lookup/commit/2fa7f0a1afb8718c6380a6b7ed8de3352034afba))

### Documentation

* enhance README with new method descriptions and usage examples ([2fa7f0a](https://github.com/chemodun/xsd-lookup/commit/2fa7f0a1afb8718c6380a6b7ed8de3352034afba))

## [1.1.1](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.1.0...xsd-lookup@v1.1.1) (2025-06-24)

### Code Refactoring

* XsdReference methods to improve return types and hierarchy handling ([397d0e9](https://github.com/chemodun/xsd-lookup/commit/397d0e9a1bb86f3aa030ec99ec7cdb7e181c805a))

## [1.1.0](https://github.com/chemodun/xsd-lookup/compare/xsd-lookup@v1.0.0...xsd-lookup@v1.1.0) (2025-06-24)

### Features

* initial release ([0b9cdc0](https://github.com/chemodun/xsd-lookup/commit/0b9cdc011961be13fde0734b6944886faa490956))

### Bug Fixes

* improve import statements in comprehensive tests ([0c57304](https://github.com/chemodun/xsd-lookup/commit/0c57304c685dc7506e4dc0565832428be52508cb))
* improve test handling and error reporting in release workflow ([2bd9479](https://github.com/chemodun/xsd-lookup/commit/2bd9479be9aa4c077446ee571c5673ea98fb362c))
* update release version to 1.0.0 and change release type to node ([787e308](https://github.com/chemodun/xsd-lookup/commit/787e308ecfca800d3599700a6a0c428a5da4c3b2))

### Miscellaneous Chores

* add markdownlint configuration file with default rules ([881122a](https://github.com/chemodun/xsd-lookup/commit/881122a0f8d930ab8d6406c3986fd884bb23464e))
* run CHANGELOG.md through markdownlint-cli2 ([2a02966](https://github.com/chemodun/xsd-lookup/commit/2a029660ce2398b97078b3fc9cd8255c69c9440d))
* run CHANGELOG.md through markdownlint-cli2 ([4b9ace1](https://github.com/chemodun/xsd-lookup/commit/4b9ace159ab6758c02eaf7d11725b3f82c0c0a1f))

## [0.2.1](https://github.com/chemodun/xsd-lookup/compare/v0.2.0...v0.2.1) (2025-06-24)

### Bug Fixes

* improve import statements in comprehensive tests ([0c57304](https://github.com/chemodun/xsd-lookup/commit/0c57304c685dc7506e4dc0565832428be52508cb))
* improve test handling and error reporting in release workflow ([2bd9479](https://github.com/chemodun/xsd-lookup/commit/2bd9479be9aa4c077446ee571c5673ea98fb362c))

## [0.2.0](https://github.com/chemodun/xsd-lookup/compare/v0.1.0...v0.2.0) (2025-06-24)

### Features

* initial release ([0b9cdc0](https://github.com/chemodun/xsd-lookup/commit/0b9cdc011961be13fde0734b6944886faa490956))
