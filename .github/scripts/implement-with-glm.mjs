import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_MODEL = process.env.BIGMODEL_MODEL || "glm-4-plus";
const DEFAULT_URL =
  process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";

async function main() {
  const apiKey = process.env.BIGMODEL_API_KEY?.trim();
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!apiKey) {
    throw new Error("BIGMODEL_API_KEY is required.");
  }

  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const issue = event.issue;
  const comment = event.comment;
  const issueBody = typeof issue?.body === "string" ? issue.body : "";
  const allowedFiles = parseBulletedSection(issueBody, "Allowed files:");

  if (!allowedFiles.length) {
    throw new Error("Could not find any allowed files in the issue body.");
  }

  const currentFiles = await Promise.all(
    allowedFiles.map(async (filePath) => ({
      path: filePath,
      content: existsSync(filePath) ? await readFile(filePath, "utf8") : "",
    })),
  );

  const agentInstructions = existsSync("AGENT.md") ? await readFile("AGENT.md", "utf8") : "";
  const response = await fetch(DEFAULT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      stream: false,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are a senior front-end implementation agent working inside GitHub Actions.",
            "Return only JSON with this shape:",
            '{ "summary": "short summary", "files": [{ "path": "file", "contentBase64": "base64 encoded full file contents" }] }',
            "Only return files from the allowed list.",
            "Every returned file must contain the full final file, not a diff.",
            "Prefer contentBase64 for every file so multiline HTML, CSS, and JavaScript stay valid JSON.",
            "Do not include markdown fences or commentary.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Repository: ${process.env.GITHUB_REPOSITORY || ""}`,
            `Issue #${issue?.number || ""}: ${issue?.title || ""}`,
            "",
            "Agent instructions:",
            agentInstructions || "None provided.",
            "",
            "Kickoff comment:",
            typeof comment?.body === "string" ? comment.body : "",
            "",
            "Issue body:",
            issueBody,
            "",
            "Current allowed files:",
            JSON.stringify(currentFiles, null, 2),
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`BigModel request failed (${response.status}): ${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("BigModel returned an empty message.");
  }

  const result = parseModelJson(content);

  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error("BigModel did not return any files to update.");
  }

  for (const file of result.files) {
    if (!file || typeof file.path !== "string") {
      throw new Error("BigModel returned an invalid file payload.");
    }

    if (!allowedFiles.includes(file.path)) {
      throw new Error(`Model attempted to edit disallowed file: ${file.path}`);
    }

    const nextContent = readFileContent(file);
    await writeFile(file.path, nextContent, "utf8");
  }

  const changedFiles = listChangedFiles();
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath) {
    await writeFile(outputPath, `changed=${changedFiles.length > 0 ? "true" : "false"}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  if (changedFiles.length === 0) {
    console.log("GLM-4 produced no file changes.");
  } else {
    console.log(`Updated files: ${changedFiles.join(", ")}`);
  }
}

function parseBulletedSection(body, heading) {
  const normalizedHeading = heading.trim().toLowerCase();
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === normalizedHeading);

  if (startIndex === -1) {
    return [];
  }

  const items = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      if (items.length > 0) {
        break;
      }
      continue;
    }

    if (!line.startsWith("- ")) {
      if (items.length > 0) {
        break;
      }
      continue;
    }

    items.push(line.slice(2).trim());
  }

  return items;
}

function parseModelJson(content) {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Unable to parse JSON returned by BigModel.");
}

function readFileContent(file) {
  if (typeof file.contentBase64 === "string") {
    return Buffer.from(file.contentBase64, "base64").toString("utf8");
  }

  if (typeof file.content === "string") {
    return file.content;
  }

  throw new Error(`BigModel did not provide content for ${file.path}.`);
}

function listChangedFiles() {
  const output = execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim();
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim().slice(3))
    .filter(Boolean);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});