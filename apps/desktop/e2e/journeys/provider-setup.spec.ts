import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, expectAccessible, setDocumentsFolder, test } from "../fixtures";

// J-02 model provider setup (PRODUCT_VISION.md section 6, FR-021, FR-022): a wrong key is
// rejected with OpenRouter's own message and never stored, a good key connects, the real
// model list fills the picker with tools models and Ask-only models apart, the chosen
// default model is saved, and the key itself is nowhere (credential store, not storage).

// Opening the folder and the scripted turn include the dev server and runtime startup.
test.describe.configure({ timeout: 90_000 });

/** SK-OR-style keys in the sanctioned fake format; never a real key. */
const WRONG_KEY = "sk-or-v1-wrong-key-0000000000";
const GOOD_KEY = "sk-or-v1-good-key-1111111111";

const TOOLS_MODEL = {
  id: "test/tools-model",
  name: "Tools Model",
  context_length: 128_000,
  supported_parameters: ["tools"],
  pricing: { prompt: "0.000003", completion: "0.000015" },
};

const CHAT_ONLY_MODEL = {
  id: "test/chat-only",
  name: "Chat Only",
  context_length: 8_000,
  supported_parameters: [],
  pricing: { prompt: "0", completion: "0" },
};

/** A local OpenRouter stand-in; the runtime is pointed at it with JESUTOBITS_OPENROUTER_URL. */
const server: Server = createServer((request, response) => {
  const authorized = request.headers.authorization === `Bearer ${GOOD_KEY}`;
  const respond = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  // Describes the key itself; answers 401 for a key OpenRouter does not know.
  if (request.method === "GET" && request.url === "/api/v1/key") {
    if (authorized) {
      respond(200, { data: {} });
    } else {
      respond(401, { error: { message: "No auth credentials found" } });
    }
    return;
  }
  if (request.method === "GET" && request.url === "/api/v1/models") {
    if (authorized) {
      respond(200, { data: [TOOLS_MODEL, CHAT_ONLY_MODEL] });
    } else {
      respond(401, { error: { message: "No auth credentials found" } });
    }
    return;
  }
  respond(404, { error: { message: "No such route" } });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
test.afterAll(() => new Promise((resolve) => server.close(resolve)));

test.use({ onboarded: false, relayEnv: { JESUTOBITS_OPENROUTER_URL: serverUrl } });

test("wrong keys are rejected and unstored, good keys connect and choose a model (J-02)", async ({
  page,
  tempDir,
}) => {
  const documents = join(tempDir, "Documents");
  mkdirSync(documents, { recursive: true });

  await page.goto("/");
  await setDocumentsFolder(page, documents);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check your tools" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Node.js" })).toContainText("Found");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a model provider" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Add your API key" })).toBeVisible();

  // A wrong key: OpenRouter's message verbatim, and the field emptied again (J-02).
  const keyInput = page.getByLabel("OpenRouter API key");
  await keyInput.fill(WRONG_KEY);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("No auth credentials found", { exact: true })).toBeVisible();
  await expect(keyInput).toHaveValue("");

  // A good key connects.
  await keyInput.fill(GOOD_KEY);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Connected to OpenRouter.")).toBeVisible();

  // The real model list: priced tools models, and Ask-only models listed apart (FR-022).
  const select = page.getByLabel("Default model");
  await expect(select.locator("option[value='test/tools-model']")).toHaveText(
    "Tools Model · 128,000 tokens · USD 3 / 15 per million",
  );
  await expect(select.locator("option[value='test/chat-only']")).toHaveText(
    "Chat Only · 8,000 tokens · USD 0 / 0 per million",
  );
  expect(
    await select
      .locator("option[value='test/chat-only']")
      .evaluate((option) => option.closest("optgroup")?.getAttribute("label")),
  ).toBe("Answers without tools");
  await select.selectOption("test/tools-model");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a look" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your first project" })).toBeVisible();
  await page.getByRole("button", { name: "Finish and go to the start screen" }).click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toBeVisible();
  await expectAccessible(page);

  // The default model was saved to settings…
  const rawSettings = await page.evaluate(() => localStorage.getItem("jesutobits.mock.settings"));
  expect(rawSettings).not.toBeNull();
  expect(JSON.parse(rawSettings ?? "{}")).toMatchObject({
    providers: { openrouter: { defaultModel: "test/tools-model" } },
  });

  // …and the keys themselves are nowhere: not in storage, not on screen (FR-021, NFR-006).
  const rawUiState = await page.evaluate(() => localStorage.getItem("jesutobits.mock.ui-state"));
  expect(rawUiState).not.toBeNull();
  for (const raw of [rawSettings, rawUiState]) {
    expect(raw ?? "").not.toContain(GOOD_KEY);
    expect(raw ?? "").not.toContain(WRONG_KEY);
  }
  const shown = await page.locator("body").innerText();
  expect(shown).not.toContain(GOOD_KEY);
  expect(shown).not.toContain(WRONG_KEY);
});
