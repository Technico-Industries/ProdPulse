const { generateRejectionSamples } = require('./generateRejectionSamples');

generateRejectionSamples().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});