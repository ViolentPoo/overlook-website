"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
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
} = require("./dedupe-streaming-service.js");

const EMPTY_REGISTRY = { version: 1, services: [] };

test("normalizes identical names and punctuation without fuzzy matching", () => {
  assert.equal(normalizeServiceName("  Example.TV!  "), normalizeServiceName("example tv"));
  assert.equal(normalizeServiceName("Example+"), normalizeServiceName("Example Plus"));
  assert.notEqual(normalizeServiceName("AB C"), normalizeServiceName("A BC"));
  assert.notEqual(normalizeServiceName("A.B"), normalizeServiceName("AB"));
  assert.notEqual(normalizeServiceName("Example Sports"), normalizeServiceName("Example Movies"));
  assert.notEqual(normalizeServiceName("Example"), normalizeServiceName("Example UK"));
});

test("resolves only explicitly verified aliases", () => {
  const aliases = buildAliasMap({
    version: 1,
    services: [{ canonical: "Example Sports", aliases: ["Example Sports TV"] }],
  });
  assert.equal(resolveServiceName("example sports tv", aliases), normalizeServiceName("Example Sports"));
  assert.notEqual(resolveServiceName("Example Sports Canada", aliases), normalizeServiceName("Example Sports"));
});

test("rejects missing or malformed service names and capabilities", () => {
  assert.equal(parseIssueForm("### Streaming service name\n\nExample"), null);
  assert.equal(parseIssueForm(issueBody("", ["Recognize and launch the installed application."])), null);
  assert.equal(parseIssueForm(issueBody("Example", ["Unrecognized capability"])), null);
  assert.equal(
    parseIssueForm(
      `${issueBody("Example", ["Other."])}\n\n### Streaming service name\n\nDifferent service`,
    ),
    null,
  );
});

test("consolidates case and punctuation variations and preserves useful fields", async () => {
  const api = new FakeApi([
    issue(1, "Example TV", ["Recognize and launch the installed application."]),
    issue(
      2,
      "example.tv",
      ["Include available programming in the TV Guide.", "Include the service in unified Search."],
      { serviceLink: "https://example.com/app", additionalInformation: "Available in Region One." },
    ),
  ]);

  const result = await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  assert.deepEqual(result, { status: "duplicate", canonicalNumber: 1 });
  assert.equal(api.issue(2).state, "closed");
  assert.ok(labels(api.issue(2)).has("duplicate"));
  const detail = api.comments(1).find((comment) => comment.body.includes("duplicate=#2"));
  assert.match(detail.body, /Include available programming in the TV Guide\./u);
  assert.match(detail.body, /Include the service in unified Search\./u);
  assert.match(detail.body, /https:\/\/example\.com\/app/u);
  assert.match(detail.body, /Available in Region One\./u);
  assert.match(summary(api, 1).body, /Confirmed requests: 2/u);
});

test("verified aliases consolidate while regional and sibling products remain separate", async () => {
  const registry = {
    version: 1,
    services: [{ canonical: "Example Sports", aliases: ["Example Sports TV"] }],
  };
  const api = new FakeApi([
    issue(1, "Example Sports", ["Include supported sports events."]),
    issue(2, "Example Movies", ["Include the service in unified Search."]),
    issue(3, "Example Sports Canada", ["Include supported sports events."]),
    issue(4, "Example Sports TV", ["Include supported sports events."]),
  ]);

  assert.equal((await processIssue(api, api.issue(2), registry)).status, "canonical");
  assert.equal((await processIssue(api, api.issue(3), registry)).status, "canonical");
  assert.deepEqual(await processIssue(api, api.issue(4), registry), {
    status: "duplicate",
    canonicalNumber: 1,
  });
});

test("serial processing consolidates simultaneous submissions into one canonical issue", async () => {
  const api = new FakeApi([
    issue(1, "Example Live", ["Include available programming in the TV Guide."]),
    issue(2, "Example Live", ["Recognize and launch the installed application."]),
    issue(3, "EXAMPLE LIVE", ["Open specific content directly when supported."]),
  ]);

  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  await processIssue(api, api.issue(3), EMPTY_REGISTRY);
  assert.equal(api.duplicateTarget(2), 1);
  assert.equal(api.duplicateTarget(3), 1);
  assert.match(summary(api, 1).body, /Confirmed requests: 3/u);
  assert.match(summary(api, 1).body, /#2, #3/u);
});

test("workflow reruns are idempotent", async () => {
  const api = new FakeApi([
    issue(1, "Example Replay", ["Recognize and launch the installed application."]),
    issue(2, "Example Replay", ["Other."]),
  ]);
  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  const commentsAfterFirstRun = api.totalComments();

  assert.equal((await processIssue(api, api.issue(2), EMPTY_REGISTRY)).status, "already-duplicate");
  assert.equal(api.totalComments(), commentsAfterFirstRun);
  assert.match(summary(api, 1).body, /Confirmed requests: 2/u);
});

test("workflow reruns repair partial duplicate processing", async () => {
  const api = new FakeApi([
    issue(1, "Example Repair", ["Recognize and launch the installed application."]),
    issue(2, "Example Repair", ["Other."]),
  ]);
  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  api.removeComments(1, "overlook-streaming-duplicate-detail:v1");
  api.issue(2).labels = [{ name: REQUEST_LABEL }];
  api.issue(2).state = "open";

  assert.equal((await processIssue(api, api.issue(2), EMPTY_REGISTRY)).status, "already-duplicate");
  assert.equal(api.issue(2).state, "closed");
  assert.ok(labels(api.issue(2)).has("duplicate"));
  assert.ok(api.comments(1).some((comment) => comment.body.includes("duplicate=#2")));
});

test("workflow reruns repair an incorrect close reason", async () => {
  const api = new FakeApi([
    issue(1, "Example Reason", ["Recognize and launch the installed application."]),
    issue(2, "Example Reason", ["Other."]),
  ]);
  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  api.issue(2).state_reason = "completed";

  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  assert.equal(api.issue(2).state, "closed");
  assert.equal(api.issue(2).state_reason, "duplicate");
});

test("previously closed duplicates contribute to derived demand", async () => {
  const api = new FakeApi([
    issue(1, "Example Archive", ["Recognize and launch the installed application."]),
    issue(2, "Example Archive", ["Other."], { state: "closed", extraLabels: ["duplicate"] }),
    issue(3, "Example Archive", ["Include the service in unified Search."]),
  ]);
  api.seedComment(
    2,
    `<!-- ${DUPLICATE_MARKER} canonical=#1 -->\n\nPreviously consolidated.`,
  );

  await processIssue(api, api.issue(3), EMPTY_REGISTRY);
  assert.equal(api.duplicateTarget(3), 1);
  assert.match(summary(api, 1).body, /Confirmed requests: 3/u);
});

test("closed non-duplicate issues are not selected as canonical discussions", async () => {
  const api = new FakeApi([
    issue(1, "Example Closed", ["Other."], { state: "closed" }),
    issue(2, "Example Closed", ["Recognize and launch the installed application."]),
  ]);

  assert.deepEqual(await processIssue(api, api.issue(2), EMPTY_REGISTRY), {
    status: "canonical",
    canonicalNumber: 2,
  });
  assert.equal(api.issue(2).state, "open");
});

test("scheduled reconciliation recovers multiple open submissions", async () => {
  const api = new FakeApi([
    issue(1, "Example Sweep", ["Other."]),
    issue(2, "Example Sweep", ["Include the service in unified Search."]),
    issue(3, "Example Sweep", ["Open specific content directly when supported."]),
  ]);

  await processOpenRequests(api, EMPTY_REGISTRY);
  assert.equal(api.issue(1).state, "open");
  assert.equal(api.issue(2).state, "closed");
  assert.equal(api.issue(3).state, "closed");
  assert.match(summary(api, 1).body, /Confirmed requests: 3/u);
});

test("manual exemption and marker removal correct an inaccurate relationship", async () => {
  const api = new FakeApi([
    issue(1, "Example One", ["Recognize and launch the installed application."]),
    issue(2, "Example One", ["Other."]),
  ]);
  await processIssue(api, api.issue(2), EMPTY_REGISTRY);
  assert.match(summary(api, 1).body, /Confirmed requests: 2/u);

  api.issue(2).labels = [{ name: REQUEST_LABEL }, { name: EXEMPT_LABEL }];
  api.issue(2).state = "open";
  api.removeComments(2, DUPLICATE_MARKER);
  await processIssue(api, api.issue(1), EMPTY_REGISTRY);

  assert.match(summary(api, 1).body, /Confirmed requests: 1/u);
  assert.equal((await processIssue(api, api.issue(2), EMPTY_REGISTRY)).status, "skipped");
});

test("workflow uses least privilege, global serialization, and no pull_request_target", () => {
  const workflow = fs.readFileSync(
    ".github/workflows/deduplicate-streaming-service-requests.yml",
    "utf8",
  );
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /issues: write/u);
  assert.match(workflow, /group: streaming-service-request-deduplication/u);
  assert.match(workflow, /queue: max/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /cron: "17 \* \* \* \*"/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event\.issue\.body/u);
});

function issue(number, serviceName, capabilities, options = {}) {
  return {
    number,
    state: options.state ?? "open",
    state_reason: options.state === "closed" ? "completed" : null,
    html_url: `https://github.com/ViolentPoo/overlook-website/issues/${number}`,
    labels: [REQUEST_LABEL, "needs-triage", ...(options.extraLabels ?? [])].map((name) => ({ name })),
    body: issueBody(serviceName, capabilities, options),
  };
}

function issueBody(serviceName, capabilities, options = {}) {
  return [
    "### Streaming service name",
    "",
    serviceName || "_No response_",
    "",
    "### Service website or Google Play link",
    "",
    options.serviceLink ?? "_No response_",
    "",
    "### What would you like OVERLOOK to support?",
    "",
    ...capabilities.map((capability) => `- [x] ${capability}`),
    "",
    "### Additional information",
    "",
    options.additionalInformation ?? "_No response_",
    "",
    "### Public information check",
    "",
    "- [x] I understand that this request and any attachments will be publicly visible.",
  ].join("\n");
}

function labels(targetIssue) {
  return new Set(targetIssue.labels.map((label) => label.name));
}

function summary(api, issueNumber) {
  return api.comments(issueNumber).find((comment) => comment.body.includes(SUMMARY_MARKER));
}

class FakeApi {
  constructor(issues) {
    this.issues = issues;
    this.commentMap = new Map();
    this.nextCommentId = 1;
  }

  issue(number) {
    return this.issues.find((candidate) => candidate.number === number);
  }

  comments(number) {
    return this.commentMap.get(number) ?? [];
  }

  async listIssues() {
    return this.issues;
  }

  async listComments(number) {
    return this.comments(number).map((comment) => ({ ...comment }));
  }

  async createComment(number, body) {
    const comment = { id: this.nextCommentId, body, user: { login: BOT_LOGIN } };
    this.nextCommentId += 1;
    this.commentMap.set(number, [...this.comments(number), comment]);
    return comment;
  }

  async updateComment(commentId, body) {
    for (const comments of this.commentMap.values()) {
      const comment = comments.find((candidate) => candidate.id === commentId);
      if (comment !== undefined) {
        comment.body = body;
        return comment;
      }
    }
    throw new Error(`Missing comment ${commentId}`);
  }

  async addLabels(number, newLabels) {
    const target = this.issue(number);
    const existing = labels(target);
    for (const name of newLabels) {
      if (!existing.has(name)) {
        target.labels.push({ name });
      }
    }
  }

  async closeIssue(number, targetIssue) {
    if (targetIssue.state === "closed" && targetIssue.state_reason === "duplicate") {
      return;
    }
    targetIssue.state = "closed";
    targetIssue.state_reason = "duplicate";
  }

  seedComment(number, body) {
    return this.createComment(number, body);
  }

  removeComments(number, marker) {
    this.commentMap.set(
      number,
      this.comments(number).filter((comment) => !comment.body.includes(marker)),
    );
  }

  duplicateTarget(number) {
    const marker = this.comments(number)
      .map((comment) => comment.body.match(/canonical=#([1-9][0-9]*)/u))
      .find((match) => match !== null);
    return marker === undefined ? null : Number(marker[1]);
  }

  totalComments() {
    return [...this.commentMap.values()].reduce((total, comments) => total + comments.length, 0);
  }
}
