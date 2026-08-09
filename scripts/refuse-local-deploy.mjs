import process from "node:process";

process.stderr.write(
  "Hosted releases are protected GitHub Actions workflows. Run the repository checks locally, then dispatch Deploy staging or Deploy production from main.\n",
);
process.exitCode = 1;
