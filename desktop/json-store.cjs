'use strict';

async function readJsonFile(filePath, io) {
  let raw;
  try {
    raw = await io.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, value: undefined };
    throw error;
  }
  return { exists: true, value: JSON.parse(raw) };
}

module.exports = { readJsonFile };
