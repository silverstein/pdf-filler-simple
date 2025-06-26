# PDF Filler for Claude Desktop

A Claude Desktop MCP extension that enables Claude to read and fill PDF forms on your computer.

## Features

### Core Features
- 📋 List PDF files in any directory
- 🔍 Read form fields from PDFs (text fields, checkboxes, dropdowns, etc.)
- ✏️ Fill PDF forms programmatically
- 💾 Save filled PDFs to new files

### Advanced Features (v0.2.0)
- 📊 **Bulk Fill from CSV** - Fill multiple PDFs using data from spreadsheets
- 👤 **Profile System** - Save and reuse common form data
- 📤 **Extract to CSV** - Export data from filled PDFs to spreadsheets
- ✅ **Form Validation** - Check for missing required fields

## Installation

### Quick Install

1. Download the latest `.dxt` file from the [Releases](https://github.com/yourusername/pdf-filler-claude/releases) page
2. Open Claude Desktop
3. Go to Settings → Extensions → Developer
4. Click "Install Extension" and select the downloaded `.dxt` file

### Build from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/pdf-filler-claude.git
cd pdf-filler-claude

# Install dependencies
npm install

# Install the DXT CLI tool
npm install -g @anthropic-ai/dxt

# Package the extension
dxt pack

# The .dxt file will be created in the current directory
```

## Usage

Once installed, you can ask Claude to:

### List PDFs
```
"List all PDFs in my Documents folder"
"Show me PDF files in /Users/myname/Downloads"
```

### Read PDF Form Fields
```
"What form fields are in the file /path/to/form.pdf?"
"Read the form fields from application.pdf on my Desktop"
```

### Fill PDF Forms
```
"Fill the PDF at /path/to/form.pdf with:
- name: John Doe
- email: john@example.com
- date: 2024-01-15
Save it to /path/to/filled-form.pdf"
```

### Bulk Fill from CSV
```
"Fill the template.pdf with data from employees.csv 
Save all PDFs to /Users/me/filled-forms/
Use the 'employee_name' column for filenames"
```

### Save and Use Profiles
```
"Save this as my 'work' profile:
- name: John Doe
- title: Software Engineer
- company: Tech Corp
- email: john@techcorp.com"

"Fill application.pdf using my work profile and save to filled-app.pdf"
```

### Extract Data to Spreadsheet
```
"Extract all data from these PDFs to summary.csv:
- /path/to/form1.pdf
- /path/to/form2.pdf
- /path/to/form3.pdf"
```

### Validate Forms
```
"Validate if all required fields are filled in application.pdf"
```

## How It Works

This extension uses:
- [MCP (Model Context Protocol)](https://github.com/anthropics/mcp) for Claude Desktop integration
- [pdf-lib](https://github.com/Hopding/pdf-lib) for PDF manipulation
- Node.js for the server runtime

## Development

### Project Structure
```
pdf-filler-claude/
├── manifest.json      # Extension metadata
├── package.json       # Node.js dependencies
├── server/
│   └── index.js      # MCP server implementation
└── README.md         # This file
```

### Available Tools

1. **list_pdfs** - Lists all PDF files in a specified directory
2. **read_pdf_fields** - Extracts form field information from a PDF
3. **fill_pdf** - Fills a PDF form with provided data
4. **bulk_fill_from_csv** - Fill multiple PDFs using CSV data
5. **save_profile** - Save form data as a reusable profile
6. **load_profile** - Load a saved profile
7. **list_profiles** - List all saved profiles
8. **fill_with_profile** - Fill a PDF using a saved profile
9. **extract_to_csv** - Extract data from PDFs to CSV
10. **validate_pdf** - Check for missing required fields

## Requirements

- Claude Desktop (with developer mode enabled)
- Node.js 18+ (for building from source)
- macOS, Windows, or Linux

## License

MIT

## Contributing

Pull requests are welcome! Please feel free to submit issues or PRs.

## Acknowledgments

Built with the [Desktop Extension Toolkit (DXT)](https://github.com/anthropics/dxt) for Claude Desktop.