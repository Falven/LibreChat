/**
 * Gets the value of an environment variable or throws an error.
 * @param varName The name of the environment variable.
 * @returns {string} The value of the environment variable.
 */
const getRequiredEnvVar = (varName) => {
  const value = process.env[varName];
  if (!value) {
    throw new Error(`Missing ${varName} environment variable.`);
  }
  return value;
};

/**
 * Gets the directory name of the current file in a manner compatible with both ESModules and CommonJS.
 * @returns {string} The directory name.
 */
const getDirname = () => __dirname;

module.exports = {
  getRequiredEnvVar,
  getDirname,
};
