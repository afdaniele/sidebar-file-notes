module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['plugin:prettier/recommended'],
  rules: {
    '@typescript-eslint/naming-convention': 'warn',
    curly: 'warn',
    eqeqeq: 'warn',
    'no-throw-literal': 'warn',
    'prettier/prettier': ['error', { endOfLine: 'auto' }]
  }
};
