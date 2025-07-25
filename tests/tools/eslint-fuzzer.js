"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const assert = require("chai").assert;
const eslint = require("../..");
const espree = require("espree");
const sinon = require("sinon");
const configRule = require("../../tools/config-rule");
const coreRules = require("../../lib/rules");

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

describe("eslint-fuzzer", function () {
	let fuzz;

	/*
	 * These tests take awhile because isolating which rule caused an error requires running eslint up to hundreds of
	 * times, one rule at a time.
	 */
	this.timeout(15000); // eslint-disable-line no-invalid-this -- Mocha timeout

	const linter = new eslint.Linter();
	const fixableRuleNames = Array.from(coreRules)
		.filter(rulePair => rulePair[1].meta && rulePair[1].meta.fixable)
		.map(rulePair => rulePair[0]);
	const CRASH_BUG = new TypeError("error thrown from a rule");

	// A comment to disable all core fixable rules
	const disableFixableRulesComment = `// eslint-disable-line ${fixableRuleNames.join(",")}`;

	before(() => {
		const realCoreRuleConfigs = configRule.createCoreRuleConfigs();

		// Make sure the config generator generates a config for "test-fuzzer-rule"
		sinon
			.stub(configRule, "createCoreRuleConfigs")
			.returns(
				Object.assign(realCoreRuleConfigs, { "test-fuzzer-rule": [2] }),
			);

		fuzz = require("../../tools/eslint-fuzzer");
	});

	after(() => {
		configRule.createCoreRuleConfigs.restore();
	});

	afterEach(() => {
		/*
		 * LazyLoadingRuleMap prototype has the `delete` property set to `undefined`
		 * in order to prevent accidental mutations, so we need to call `Map.prototype.delete`
		 * directly here.
		 */
		Map.prototype.delete.call(coreRules, "test-fuzzer-rule");
	});

	/*
	 * LazyLoadingRuleMap prototype has the `set` property set to `undefined`
	 * in order to prevent accidental mutations, so we need to call `Map.prototype.set`
	 * directly in tests that add `test-fuzzer-rule`.
	 */

	describe("when running in crash-only mode", () => {
		describe("when a rule crashes on the given input", () => {
			it("should report the crash with a minimal config", () => {
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					create: context => ({
						Program() {
							if (context.sourceCode.text === "foo") {
								throw CRASH_BUG;
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,
					codeGenerator: () => "foo",
					checkAutofixes: false,
					linter,
				});

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].type, "crash");
				assert.strictEqual(results[0].text, "foo");
				assert.deepStrictEqual(results[0].config.rules, {
					"test-fuzzer-rule": 2,
				});
				assert.strictEqual(results[0].error, CRASH_BUG.stack);
			});
		});

		describe("when no rules crash", () => {
			it("should return an empty array", () => {
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					create: () => ({}),
				}));

				assert.deepStrictEqual(
					fuzz({
						count: 1,
						codeGenerator: () => "foo",
						checkAutofixes: false,
						linter,
					}),
					[],
				);
			});
		});
	});

	describe("when running in crash-and-autofix mode", () => {
		const INVALID_SYNTAX = "this is not valid javascript syntax";
		let expectedSyntaxError;

		try {
			espree.parse(INVALID_SYNTAX);
		} catch (err) {
			expectedSyntaxError = err;
		}

		describe("when a rule crashes on the given input", () => {
			it("should report the crash with a minimal config", () => {
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					create: context => ({
						Program() {
							if (context.sourceCode.text === "foo") {
								throw CRASH_BUG;
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,
					codeGenerator: () => "foo",
					checkAutofixes: false,
					linter,
				});

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].type, "crash");
				assert.strictEqual(results[0].text, "foo");
				assert.deepStrictEqual(results[0].config.rules, {
					"test-fuzzer-rule": 2,
				});
				assert.strictEqual(results[0].error, CRASH_BUG.stack);
			});
		});

		describe("when a rule's autofix produces valid syntax", () => {
			it("does not report any errors", () => {
				// Replaces programs that start with "foo" with "bar"
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					meta: { fixable: "code" },
					create: context => ({
						Program(node) {
							if (
								context.sourceCode.text ===
								`foo ${disableFixableRulesComment}`
							) {
								context.report({
									node,
									message: "no foos allowed",
									fix: fixer =>
										fixer.replaceText(
											node,
											`bar ${disableFixableRulesComment}`,
										),
								});
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,

					/*
					 * To ensure that no other rules produce a different autofix and mess up the test, add a big disable
					 * comment for all core fixable rules.
					 */
					codeGenerator: () => `foo ${disableFixableRulesComment}`,
					checkAutofixes: true,
					linter,
				});

				assert.deepStrictEqual(results, []);
			});
		});

		describe("when a rule's autofix produces invalid syntax on the first pass", () => {
			it("reports an autofix error with a minimal config", () => {
				// Replaces programs that start with "foo" with invalid syntax
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					meta: { fixable: "code" },
					create: context => ({
						Program(node) {
							const sourceCode = context.sourceCode;

							if (
								sourceCode.text ===
								`foo ${disableFixableRulesComment}`
							) {
								context.report({
									node,
									message: "no foos allowed",
									fix: fixer =>
										fixer.replaceTextRange(
											[0, sourceCode.text.length],
											INVALID_SYNTAX,
										),
								});
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,
					codeGenerator: () => `foo ${disableFixableRulesComment}`,
					checkAutofixes: true,
					linter,
				});

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].type, "autofix");
				assert.strictEqual(
					results[0].text,
					`foo ${disableFixableRulesComment}`,
				);
				assert.deepStrictEqual(results[0].config.rules, {
					"test-fuzzer-rule": 2,
				});
				assert.deepStrictEqual(results[0].error, {
					ruleId: null,
					fatal: true,
					severity: 2,
					message: `Parsing error: ${expectedSyntaxError.message}`,
					line: expectedSyntaxError.lineNumber,
					column: expectedSyntaxError.column,
					nodeType: null,
				});
			});
		});

		describe("when a rule's autofix produces invalid syntax on the second pass", () => {
			it("reports an autofix error with a minimal config and the text from the second pass", () => {
				const intermediateCode = `bar ${disableFixableRulesComment}`;

				// Replaces programs that start with "foo" with invalid syntax
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					meta: { fixable: "code" },
					create: context => ({
						Program(node) {
							const sourceCode = context.sourceCode;

							if (
								sourceCode.text.startsWith("foo") ||
								sourceCode.text === intermediateCode
							) {
								context.report({
									node,
									message: "no foos allowed",
									fix(fixer) {
										return fixer.replaceTextRange(
											[0, sourceCode.text.length],
											sourceCode.text === intermediateCode
												? INVALID_SYNTAX
												: intermediateCode,
										);
									},
								});
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,
					codeGenerator: () => `foo ${disableFixableRulesComment}`,
					checkAutofixes: true,
					linter,
				});

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].type, "autofix");
				assert.strictEqual(results[0].text, intermediateCode);
				assert.deepStrictEqual(results[0].config.rules, {
					"test-fuzzer-rule": 2,
				});
				assert.deepStrictEqual(results[0].error, {
					ruleId: null,
					fatal: true,
					severity: 2,
					message: `Parsing error: ${expectedSyntaxError.message}`,
					line: expectedSyntaxError.lineNumber,
					column: expectedSyntaxError.column,
					nodeType: null,
				});
			});
		});

		describe("when a rule crashes on the second autofix pass", () => {
			it("reports a crash error with a minimal config", () => {
				// Replaces programs that start with "foo" with invalid syntax
				Map.prototype.set.call(coreRules, "test-fuzzer-rule", () => ({
					meta: { fixable: "code" },
					create: context => ({
						Program(node) {
							const sourceCode = context.sourceCode;

							if (sourceCode.text.startsWith("foo")) {
								context.report({
									node,
									message: "no foos allowed",
									fix: fixer =>
										fixer.replaceText(node, "bar"),
								});
							} else if (
								sourceCode.text ===
								`bar ${disableFixableRulesComment}`
							) {
								throw CRASH_BUG;
							}
						},
					}),
				}));

				const results = fuzz({
					count: 1,
					codeGenerator: () => `foo ${disableFixableRulesComment}`,
					checkAutofixes: true,
					linter,
				});

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].type, "crash");

				assert.strictEqual(
					results[0].text,
					`bar ${disableFixableRulesComment}`,
				);
				assert.deepStrictEqual(results[0].config.rules, {
					"test-fuzzer-rule": 2,
				});
				assert.strictEqual(results[0].error, CRASH_BUG.stack);
			});
		});
	});
});
