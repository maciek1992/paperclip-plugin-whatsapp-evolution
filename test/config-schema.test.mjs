// Ten sam walidator co serwer Paperclip (plugin-config-validator: ajv strict + ajv-formats + format "secret-ref").
import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import manifest from "../dist/manifest.js";

function serverLikeValidator() {
  const ajv = new Ajv();
  (addFormats.default ?? addFormats)(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(manifest.instanceConfigSchema);
}

test("schemat ustawień kompiluje się w trybie strict jak na serwerze", () => {
  assert.doesNotThrow(() => serverLikeValidator());
});

test("typowa konfiguracja przechodzi walidację serwera", () => {
  const validate = serverLikeValidator();
  const ok = validate({
    evolutionUrl: "http://evolution.example:8080",
    evolutionApiKey: { type: "secret_ref", secretId: "6c1d1b52-0000-4000-8000-000000000000", version: "latest" },
    instanceName: "wa-main",
    groupName: "Agent",
    allowedNumbers: ["48600123456"],
    defaultAgentName: "CEO",
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});
