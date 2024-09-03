/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  rootDir: './',
  roots: [ './app' ],
  verbose: true,
  transform: {
    '^.+\\.ts?$': [
      'ts-jest',
      {
        isolatedModules: true,
      }
    ]
  },
  setupFilesAfterEnv: [
    './jest.setup.ts',
  ],
  testRegex: '((\\.|/*.)\\.(test))\\.ts?$',
  preset: 'ts-jest',
  testEnvironment: 'node',
};