import { expect, test } from "bun:test";
import { CONTAINER_APPS_CLOUD, resourceAttributes } from "./release";

const RELEASE = {
	id: "rel_0123456789abcdef01234567",
	version: "12",
	environment: "development",
	revision: "ca-backend-abc--azd-1764064023",
};

test("a released process on Container Apps carries the whole stamp, and its version is the release's", () => {
	expect(
		resourceAttributes({
			serviceName: "assistant-backend",
			serviceVersion: "v12-4f2a9c1",
			release: RELEASE,
		}),
	).toEqual({
		"service.name": "assistant-backend",
		"service.version": "12",
		"impact.release.id": RELEASE.id,
		"impact.release.version": "12",
		"impact.release.revision": RELEASE.revision,
		"deployment.environment.name": "development",
		"cloud.provider": "azure",
		"cloud.platform": "azure_container_apps",
	});
	expect(CONTAINER_APPS_CLOUD).toEqual({
		provider: "azure",
		platform: "azure_container_apps",
	});
});

test("outside a release the version stays the image's tag, and nothing empty is sent", () => {
	expect(
		resourceAttributes({
			serviceName: "frontend",
			serviceVersion: "azd-deploy-1764064023",
			release: { id: "", version: " ", environment: undefined },
		}),
	).toEqual({
		"service.name": "frontend",
		"service.version": "azd-deploy-1764064023",
	});
	expect(resourceAttributes({ serviceName: "frontend" })).toEqual({
		"service.name": "frontend",
	});
});

test("only a process Container Apps runs, which names its revision, claims the cloud", () => {
	const { revision: _, ...offPlatform } = RELEASE;
	const attributes = resourceAttributes({
		serviceName: "frontend",
		release: offPlatform,
	});
	expect(attributes["impact.release.id"]).toBe(RELEASE.id);
	expect(attributes).not.toHaveProperty("cloud.provider");
	expect(attributes).not.toHaveProperty("cloud.platform");
	expect(attributes).not.toHaveProperty("impact.release.revision");
	// A revision with no release is still the platform's.
	expect(
		resourceAttributes({
			serviceName: "frontend",
			release: { revision: RELEASE.revision },
		}),
	).toMatchObject({
		"impact.release.revision": RELEASE.revision,
		"cloud.platform": "azure_container_apps",
	});
});
