import { expect, test } from "bun:test";
import { mediaSrc } from "@/app/components/media-src";
import { isSameOriginPath } from "./same-origin";

const OTHER_HOSTS = [
	"//evil.example/p.png",
	"/\\evil.example/p.png",
	"/\\/evil.example/p.png",
	"/\t/evil.example/p.png",
	"/\n/evil.example/p.png",
	"/\r\n/evil.example/p.png",
	"\\\\evil.example/p.png",
	"https://evil.example/p.png",
	"javascript:alert(1)",
	"",
];

test("a path is this origin's only when a browser would read it so", () => {
	for (const url of OTHER_HOSTS) expect(isSameOriginPath(url)).toBe(false);
	expect(isSameOriginPath("/api/media/a/images/b.png")).toBe(true);
	expect(isSameOriginPath("/")).toBe(true);
	// An encoded backslash is a character of the path, not a separator.
	expect(isSameOriginPath("/%5cevil.example/p.png")).toBe(true);
	expect(isSameOriginPath("/%5Cevil.example/p.png")).toBe(true);
});

test("a path that names another host is no picture, never a src", () => {
	for (const url of OTHER_HOSTS.filter(Boolean))
		expect(mediaSrc(url)).toBeNull();
	expect(mediaSrc("/api/media/a/images/b.png")).toBe(
		"/api/media/a/images/b.png",
	);
	expect(mediaSrc("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
});

test("a picture's path is the media route's and no other route of this app", () => {
	for (const url of [
		"/api/account/export",
		"/api/conversations",
		"/chat",
		"/api/media",
		"/api/media/../account/export",
		"/api/mediax/a.png",
	])
		expect(mediaSrc(url)).toBeNull();
});
