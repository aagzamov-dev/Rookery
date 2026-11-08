import { expect, it } from "vitest";
import { credentialsText } from "./credentials";

it("copies address, port, user and the password when saved", () => {
  expect(credentialsText({ address: "192.168.40.213", port: 22, username: "administrator", auth: "password", password: "p w", keyPath: null })).toBe(
    "Host: 192.168.40.213\nPort: 22\nUser: administrator\nPassword: p w",
  );
  expect(credentialsText({ address: "h", port: 2222, username: "u", auth: "password", password: null, keyPath: null })).toContain("Password: (not saved)");
  expect(credentialsText({ address: "h", port: 22, username: "u", auth: "key_file", password: null, keyPath: "~/.ssh/id_ed25519" })).toContain("Key file: ~/.ssh/id_ed25519");
  expect(credentialsText({ address: "h", port: 22, username: "u", auth: "key_in_vault", password: null, keyPath: null })).not.toContain("Password");
});
