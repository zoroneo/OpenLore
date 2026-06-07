/**
 * Canonical test-file predicate shared by the call-graph builder and the
 * artifact generator. These two must agree: the artifact generator excludes
 * test files from signature extraction and the production edge store, while the
 * call-graph builder marks their nodes `isTest` and derives `tested_by` edges.
 * When the two definitions diverged, test code using directory conventions
 * (tests/, __tests__/) or *Spec.kt/*Test.scala leaked into the production graph
 * (polluting hubs/entry-points/stats) and `tested_by` edges were silently lost.
 *
 * Covers, by language:
 *   JS/TS:        foo.test.ts, foo.spec.tsx, __tests__/foo.ts
 *   Python:       test_foo.py, foo_test.py
 *   Go:           foo_test.go
 *   Ruby/PHP:     tests/foo.rb, tests/foo.php (directory convention)
 *   Java/Kotlin:  FooTest.java, FooSpec.kt
 *   Scala:        FooTest.scala, FooSpec.scala
 */
export function isTestFile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, '/');
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) ||   // JS/TS: foo.test.ts
    /(^|\/)__tests__\//.test(name) ||                          // JS/TS: __tests__/
    /(^|\/)test_[^/]+\.(ts|js|py)$/.test(name) ||             // Python/TS: test_foo.py
    /[^/]+_test\.(py|go)$/.test(name) ||                      // Python/Go: foo_test.py, foo_test.go
    /(^|\/)tests?\/[^/]+\.(py|ts|js|rb|php)$/.test(name) ||  // tests/ directory
    /[A-Z][a-zA-Z0-9]*Test\.(java|kt|scala)$/.test(name) ||  // Java: FooTest.java
    /[A-Z][a-zA-Z0-9]*Spec\.(kt|scala|rb)$/.test(name)       // Kotlin/Ruby: FooSpec.kt
  );
}
