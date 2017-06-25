import * as fs from "fs";

console.log(`size=${fs.statSync("src/cpm22.bin").size.toString(16)}`);