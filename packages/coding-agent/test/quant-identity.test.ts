import { describe, expect, it } from "vitest";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";

describe("Quant distribution identity", () => {
	it("keeps terminal identity and default state separate from upstream Pi", () => {
		expect(APP_NAME).toBe("qagent");
		expect(APP_TITLE).toBe("Quant Agent");
		expect(CONFIG_DIR_NAME).toBe(".quant-agent");
		expect(ENV_AGENT_DIR).toBe("QAGENT_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("QAGENT_CODING_AGENT_SESSION_DIR");
	});
});
