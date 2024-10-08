const fs = require("fs");
const path = require("path");

// Directory containing the CSV files
const directoryPath = "./"; // Assuming the script is in the same directory as the CSV files

// Function to combine all CSV files by appending them
const combineCSVFiles = async () => {
  try {
    // Read all files in the directory
    const files = fs
      .readdirSync(directoryPath)
      .filter((file) => file.endsWith(".csv"));

    if (files.length === 0) {
      console.log("No CSV files found.");
      return;
    }

    const outputFilePath = path.join(directoryPath, "combined_output.csv");

    // Clear the output file if it exists, or create it
    fs.writeFileSync(outputFilePath, "", "utf8");

    // Loop through each file and append its content to the output file
    files.forEach((file) => {
      const filePath = path.join(directoryPath, file);
      const fileContent = fs.readFileSync(filePath, "utf8");

      // Append the content of the current file to the output file
      fs.appendFileSync(outputFilePath, fileContent + "\n", "utf8");
    });

    console.log(`CSV files combined successfully into ${outputFilePath}`);
  } catch (err) {
    console.error("Error combining CSV files:", err);
  }
};

// Run the combineCSVFiles function
combineCSVFiles();
