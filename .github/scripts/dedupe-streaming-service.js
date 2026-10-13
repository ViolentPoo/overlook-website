"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const REQUEST_LABEL = "streaming-service-request";
const DUPLICATE_LABEL = "duplicate";
const EXEMPT_LABEL = "deduplication-exempt";
const BOT_LOGIN = "github-actions[bot]";
const DUPLICATE_MARKER = "overlook-streaming-duplicate:v1";
const DETAIL_MARKER = "overlook-streaming-duplicate-detail:v1";
const SUMMARY_MARKER = "overlook-streaming-demand:v1";
const EXPECTED_CAPABILITIES = new Set([
  "Recognize and launch the installed application.",
  "Include available programming in the TV Guide.",
  "Include supported sports events.",
  "Include the service in unified Search.",
  "Open specific content directly when supported.",
  "Other.",
]);

function normalizeServiceName(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/\+/gu, " plus ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildAliasMap(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.services)) {
    throw new Error("Invalid streaming-service alias registry");
  }
  const aliases = new Map();
  for (const service of registry.services) {
    if (typeof service?.canonical !== "string" || !Array.isArray(service.aliases)) {
      throw new Error("Invalid streaming-service alias entry");
    }
    const canonicalKey = normalizeServiceName(service.canonical);
    if (canonicalKey === "") {
      throw new Error("Alias entries require a canonical service name");
    }
    for (const name of [service.canonical, ...service.aliases]) {
      if (typeof name !== "string" || normalizeServiceName(name) === "") {
        throw new Error("Alias entries must contain non-empty strings");
      }
      const aliasKey = normalizeServiceName(name);
      const existing = aliases.get(aliasKey);
      if (existing !== undefined && existing !== canonicalKey) {
        throw new Error(`Conflicting streaming-service alias: ${name}`);
      }
      aliases.set(aliasKey, canonicalKey);
    }
  }
  return aliases;
}

function resolveServiceName(value, aliasMap) {
  const normalized = normalizeServiceName(value);
  return aliasMap.get(normalized) ?? normalized;
}

function parseIssueForm(body) {
  if (typeof body !== "string") {
    return null;
  }
  const expectedHeadings = [
    "Streaming service name",
    "Service website or Google Play link",
    "What would you like OVERLOOK to support?",
    "Additional information",
    "Public information check",
  ];
  const allHeadings = [...body.matchAll(/^###\s+(.+?)\s*$/gmu)];
  const headings = [];
  for (const expected of expectedHeadings) {
    const matches = allHeadings.filter(
      (match) => match[1].trim().toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US"),
    );
    if (matches.length !== 1) {
      return null;
    }
    headings.push(matches[0]);
  }
  if (headings.some((heading, index) => index > 0 && heading.index <= headings[index - 1].index)) {
    return null;
  }
  const fields = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const next = headings[index + 1];
    fields.set(
      match[1].trim().toLocaleLowerCase("en-US"),
      body.slice(match.index + match[0].length, next?.index ?? body.length).trim(),
    );
  }

  const serviceName = fields.get("streaming service name");
  const capabilities = fields.get("what would you like overlook to support?");
  if (
    serviceName === undefined ||
    serviceName === "" ||
    serviceName === "_No response_" ||
    serviceName.length > 120 ||
    serviceName.includes("\n") ||
    capabilities === undefined
  ) {
    return null;
  }
  const selectedCapabilities = [...capabilities.matchAll(/^- \[[xX]\]\s+(.+)$/gmu)]
    .map((match) => match[1].trim())
    .filter((capability) => EXPECTED_CAPABILITIES.has(capability));
  if (selectedCapabilities.length === 0) {
    return null;
  }

  return {
    serviceName,
    serviceLink: optionalField(fields.get("service website or google play link")),
    capabilities: selectedCapabilities,
    additionalInformation: optionalField(fields.get("additional information")),
  };
}

function optionalField(value) {
  return value === undefined || value === "" || value === "_No response_" ? null : value;
}

function labelNames(issue) {
  return new Set((issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
}

function trustedMarker(comments, marker) {
  return comments.find(
    (comment) => comment.user?.login === BOT_LOGIN && comment.body?.includes(`<!-- ${marker}`),
  );
}

function duplicateTarget(comments) {
  const comment = trustedMarker(comments, DUPLICATE_MARKER);
  const match = comment?.body?.match(
    /<!-- overlook-streaming-duplicate:v1 canonical=#([1-9][0-9]*) -->/u,
  );
  return match === undefined || match === null ? null : Number(match[1]);
}

function safeMarkdown(value, maximumLength = 3_000) {
  return value
    .replace(/<!--/gu, "&lt;!--")
    .replace(/-->/gu, "--&gt;")
    .replace(/@/gu, "@\u200b")
    .slice(0, maximumLength);
}

async function processIssue(api, issue, registry) {
  const labels = labelNames(issue);
  if (!labels.has(REQUEST_LABEL) || labels.has(EXEMPT_LABEL) || issue.pull_request !== undefined) {
    return { status: "skipped" };
  }
  const fields = parseIssueForm(issue.body);
  if (fields === null) {
    return { status: "malformed" };
  }

  const aliasMap = buildAliasMap(registry);
  const identity = resolveServiceName(fields.serviceName, aliasMap);
  if (identity === "") {
    return { status: "malformed" };
  }
  const issues = (await api.listIssues(REQUEST_LABEL)).filter(
    (candidate) => candidate.pull_request === undefined,
  );
  const commentCache = new Map();
  const commentsFor = async (number) => {
    if (!commentCache.has(number)) {
      commentCache.set(number, await api.listComments(number));
    }
    return commentCache.get(number);
  };

  const currentComments = await commentsFor(issue.number);
  const existingTarget = duplicateTarget(currentComments);
  if (existingTarget !== null) {
    const existingCanonical = issues.find(
      (candidate) => candidate.number === existingTarget && labelNames(candidate).has(REQUEST_LABEL),
    );
    if (existingCanonical === undefined) {
      throw new Error(`Canonical issue #${existingTarget} is unavailable`);
    }
    await ensureComment(
      api,
      existingTarget,
      await commentsFor(existingTarget),
      `${DETAIL_MARKER} duplicate=#${issue.number}`,
      buildDetailComment(issue, fields),
    );
    await api.addLabels(issue.number, [DUPLICATE_LABEL]);
    await api.closeIssue(issue.number, issue);
    await ensureDemandSummary(api, existingTarget, issues, commentsFor);
    return { status: "already-duplicate", canonicalNumber: existingTarget };
  }

  let canonical = null;
  for (const candidate of issues
    .filter((entry) => entry.number < issue.number)
    .sort((left, right) => left.number - right.number)) {
    const candidateLabels = labelNames(candidate);
    if (
      candidate.state !== "open" ||
      candidateLabels.has(EXEMPT_LABEL) ||
      candidateLabels.has(DUPLICATE_LABEL)
    ) {
      continue;
    }
    const candidateFields = parseIssueForm(candidate.body);
    if (
      candidateFields === null ||
      resolveServiceName(candidateFields.serviceName, aliasMap) !== identity ||
      duplicateTarget(await commentsFor(candidate.number)) !== null
    ) {
      continue;
    }
    canonical = candidate;
    break;
  }

  if (canonical === null) {
    await ensureDemandSummary(api, issue.number, issues, commentsFor);
    return { status: "canonical", canonicalNumber: issue.number };
  }

  await ensureComment(
    api,
    canonical.number,
    await commentsFor(canonical.number),
    `${DETAIL_MARKER} duplicate=#${issue.number}`,
    buildDetailComment(issue, fields),
  );
  await ensureComment(
    api,
    issue.number,
    currentComments,
    `${DUPLICATE_MARKER} canonical=#${canonical.number}`,
    `<!-- ${DUPLICATE_MARKER} canonical=#${canonical.number} -->\n\n` +
      `Thanks for the request. This has been consolidated into #${canonical.number} so discussion and demand stay in one place.`,
  );
  await api.addLabels(issue.number, [DUPLICATE_LABEL]);
  await api.closeIssue(issue.number, issue);

  commentCache.set(issue.number, await api.listComments(issue.number));
  await ensureDemandSummary(api, canonical.number, issues, commentsFor);
  return { status: "duplicate", canonicalNumber: canonical.number };
}

async function processOpenRequests(api, registry) {
  const issues = (await api.listIssues(REQUEST_LABEL))
    .filter((issue) => issue.state === "open" && issue.pull_request === undefined)
    .sort((left, right) => left.number - right.number);
  const results = [];
  for (const issue of issues) {
    results.push(await processIssue(api, issue, registry));
  }
  return results;
}

function buildDetailComment(issue, fields) {
  const lines = [
    `<!-- ${DETAIL_MARKER} duplicate=#${issue.number} -->`,
    "",
    `### Additional request consolidated from #${issue.number}`,
    "",
    `**Service name:** ${safeMarkdown(fields.serviceName, 120)}`,
    "",
    "**Requested capabilities:**",
    ...fields.capabilities.map((capability) => `- ${safeMarkdown(capability, 200)}`),
  ];
  if (fields.serviceLink !== null) {
    lines.push("", "**Service website or Google Play link:**", safeMarkdown(fields.serviceLink));
  }
  if (fields.additionalInformation !== null) {
    lines.push("", "**Additional information:**", safeMarkdown(fields.additionalInformation));
  }
  return lines.join("\n");
}

async function ensureComment(api, issueNumber, comments, marker, body) {
  if (trustedMarker(comments, marker) === undefined) {
    await api.createComment(issueNumber, body);
  }
}

async function ensureDemandSummary(api, canonicalNumber, issues, commentsFor) {
  const duplicates = [];
  for (const issue of issues) {
    if (issue.number === canonicalNumber || labelNames(issue).has(EXEMPT_LABEL)) {
      continue;
    }
    if (duplicateTarget(await commentsFor(issue.number)) === canonicalNumber) {
      duplicates.push(issue.number);
    }
  }
  duplicates.sort((left, right) => left - right);
  const count = 1 + duplicates.length;
  const links = duplicates.length === 0
    ? "No confirmed duplicates have been consolidated."
    : `Consolidated requests: ${duplicates.map((number) => `#${number}`).join(", ")}`;
  const body = `<!-- ${SUMMARY_MARKER} -->\n\n### Request demand\n\n` +
    `**Confirmed requests: ${count}**\n\n${links}\n\n` +
    "This count is derived from linked duplicate issues and includes this canonical request.";
  const comments = await commentsFor(canonicalNumber);
  const existing = trustedMarker(comments, SUMMARY_MARKER);
  if (existing === undefined) {
    await api.createComment(canonicalNumber, body);
  } else if (existing.body !== body) {
    await api.updateComment(existing.id, body);
  }
}

class GitHubApi {
  constructor(owner, repository, token) {
    this.owner = owner;
    this.repository = repository;
    this.token = token;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "overlook-streaming-service-deduplicator",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async paginated(endpoint) {
    const results = [];
    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const batch = await this.request("GET", `${endpoint}${separator}per_page=100&page=${page}`);
      results.push(...batch);
      if (batch.length < 100) {
        return results;
      }
    }
  }

  listIssues(label) {
    return this.paginated(
      `/repos/${this.owner}/${this.repository}/issues?state=all&sort=created&direction=asc&labels=${encodeURIComponent(label)}`,
    );
  }

  listComments(issueNumber) {
    return this.paginated(`/repos/${this.owner}/${this.repository}/issues/${issueNumber}/comments`);
  }

  createComment(issueNumber, body) {
    return this.request(
      "POST",
      `/repos/${this.owner}/${this.repository}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  updateComment(commentId, body) {
    return this.request(
      "PATCH",
      `/repos/${this.owner}/${this.repository}/issues/comments/${commentId}`,
      { body },
    );
  }

  addLabels(issueNumber, labels) {
    return this.request(
      "POST",
      `/repos/${this.owner}/${this.repository}/issues/${issueNumber}/labels`,
      { labels },
    );
  }

  async closeIssue(issueNumber, issue) {
    if (issue.state === "closed" && issue.state_reason === "duplicate") {
      return;
    }
    if (issue.state === "closed") {
      await this.request(
        "PATCH",
        `/repos/${this.owner}/${this.repository}/issues/${issueNumber}`,
        { state: "open" },
      );
    }
    await this.request(
      "PATCH",
      `/repos/${this.owner}/${this.repository}/issues/${issueNumber}`,
      { state: "closed", state_reason: "duplicate" },
    );
  }

  getIssue(issueNumber) {
    return this.request("GET", `/repos/${this.owner}/${this.repository}/issues/${issueNumber}`);
  }
}

async function main() {
  const [owner, repository] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || repository === undefined) {
    throw new Error("GITHUB_REPOSITORY must contain owner/repository");
  }
  const api = new GitHubApi(owner, repository, requiredEnvironment("GITHUB_TOKEN"));
  const event = JSON.parse(await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const requestedIssueNumber = process.env.ISSUE_NUMBER?.trim();
  let issue = event.issue;
  if (requestedIssueNumber !== undefined && requestedIssueNumber !== "") {
    const issueNumber = Number(requestedIssueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new Error("ISSUE_NUMBER must be a positive integer");
    }
    issue = await api.getIssue(issueNumber);
  }
  const registry = JSON.parse(
    await fs.readFile(path.join(__dirname, "..", "streaming-service-aliases.json"), "utf8"),
  );
  if (issue === undefined) {
    const results = await processOpenRequests(api, registry);
    console.log(`Streaming-service reconciliation processed ${results.length} open requests`);
  } else {
    if (!Number.isInteger(issue.number)) {
      throw new Error("A valid issue event or workflow input is required");
    }
    const result = await processIssue(api, issue, registry);
    console.log(`Streaming-service deduplication result: ${result.status}`);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  BOT_LOGIN,
  DUPLICATE_MARKER,
  EXEMPT_LABEL,
  REQUEST_LABEL,
  SUMMARY_MARKER,
  buildAliasMap,
  normalizeServiceName,
  parseIssueForm,
  processIssue,
  processOpenRequests,
  resolveServiceName,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown automation error");
    process.exitCode = 1;
  });
}
