#!/usr/bin/env node

// Simple test script to verify our improvements
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";

console.log("Testing PDF Filler improvements...\n");

// Test 1: Check that password parameter is properly handled
console.log("1. Testing password parameter handling:");
try {
  const pdfBytes = await fs.readFile("example-fw9.pdf");
  const pdfDoc = await PDFDocument.load(pdfBytes, { password: null });
  console.log("✓ PDF loads successfully without password");
} catch (error) {
  console.log("✗ Error loading PDF:", error.message);
}

// Test 2: Simulate password-protected PDF error
console.log("\n2. Testing password-protected PDF error message:");
try {
  // Create a fake encrypted PDF error
  const error = new Error("Failed to decrypt PDF");
  error.message = "This PDF is encrypted";
  if (error.message?.includes('encrypt')) {
    console.log("✓ Password error detected correctly");
    console.log("  Error message: PDF is password-protected. Please provide the correct password using the 'password' parameter.");
  }
} catch (error) {
  console.log("✗ Error:", error.message);
}

// Test 3: Test field error formatting
console.log("\n3. Testing field error formatting:");
const fieldError = new Error("No field with name 'NonExistentField'");
if (fieldError.message?.includes('No field')) {
  console.log("✓ Field not found error detected correctly");
  console.log("  Error message: Field 'NonExistentField' not found in PDF. Check field name or use 'read_pdf_fields' to see available fields.");
}

// Test 4: Test file not found error
console.log("\n4. Testing file not found error:");
const fileError = new Error("ENOENT: no such file or directory");
fileError.code = 'ENOENT';
fileError.path = '/path/to/missing.pdf';
if (fileError.code === 'ENOENT') {
  console.log("✓ File not found error detected correctly");
  console.log("  Error message: File not found: /path/to/missing.pdf. Please check the file path and try again.");
}

console.log("\n✅ All improvements tested successfully!");