module.exports = {
    testEnvironment: 'node',
    moduleDirectories: ['node_modules'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1'
    },
    testMatch: ['**/tests/**/*.test.js'],
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/tests/setup.js'
    ],
    setupFilesAfterEnv: ['./tests/setup.js'],
    testTimeout: 10000,
    clearMocks: true,
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    verbose: true
}; 