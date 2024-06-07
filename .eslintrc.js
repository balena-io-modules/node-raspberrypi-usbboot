module.exports = {
  extends: ["./node_modules/@balena/lint/config/.eslintrc.js"],
  root: true,
  ignorePatterns: ["node_modules/"],
  rules: {
    "no-bitwise": "off",
  },
};
