#!/usr/bin/env node
// Slipway is now SlipJay. This entry point only refuses, naming the command to run instead.
process.stderr.write(`slipway is now slipjay. Run instead:\n  slipjay${process.argv.slice(2).map((argument) => ` ${argument}`).join("")}\n`);
process.exitCode = 1;
