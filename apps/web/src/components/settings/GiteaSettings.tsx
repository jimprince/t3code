import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { GITEA_TOKEN_REDACTED, GiteaInstanceConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const decodeGiteaInstance = Schema.decodeUnknownSync(GiteaInstanceConfig);

function GiteaInstanceForm({
  instance,
  save,
  remove,
}: {
  instance: GiteaInstanceConfig;
  save: (value: GiteaInstanceConfig) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="space-y-3 py-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const split = (name: string) =>
          String(data.get(name) ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        setSaving(true);
        setError("");
        try {
          const value = decodeGiteaInstance({
            id: instance.id,
            host: data.get("host"),
            webOrigin: data.get("webOrigin"),
            apiOrigin: data.get("apiOrigin"),
            sshAliases: split("sshAliases"),
            sshPorts: split("sshPorts").map(Number),
            token: String(data.get("token") ?? "").trim() || instance.token,
          });
          await save(value);
          const tokenInput = form.elements.namedItem("token");
          if (tokenInput instanceof HTMLInputElement) tokenInput.value = "";
        } catch {
          setError("Could not save. Check the host, ports, HTTP origins, and server connection.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["host", "Host", instance.host, "git.example"],
            [
              "sshAliases",
              "SSH aliases (comma separated)",
              instance.sshAliases.join(", "),
              "my-git",
            ],
            ["sshPorts", "SSH ports (comma separated)", instance.sshPorts.join(", "), "22, 2222"],
            ["webOrigin", "Web origin", instance.webOrigin, "http://git.example:3000"],
            [
              "apiOrigin",
              "API origin (without /api/v1)",
              instance.apiOrigin,
              "http://git.example:3000",
            ],
          ] as const
        ).map(([name, label, value, placeholder]) => (
          <label key={name} className="space-y-1 text-sm">
            <span>{label}</span>
            <Input
              name={name}
              defaultValue={value}
              placeholder={placeholder}
              required={name !== "sshAliases"}
            />
          </label>
        ))}
        <label className="space-y-1 text-sm">
          <span>Personal access token {instance.token ? GITEA_TOKEN_REDACTED : ""}</span>
          <Input
            name="token"
            type="password"
            autoComplete="new-password"
            placeholder={
              instance.token ? "Leave blank to keep saved token" : "Personal access token"
            }
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          Save Gitea instance
        </Button>
        {instance.token ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              void save({ ...instance, token: "" }).catch(() => setError("Could not clear token."));
            }}
          >
            Clear token
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            void remove().catch(() => setError("Could not remove instance."));
          }}
        >
          Remove
        </Button>
      </div>
    </form>
  );
}

export function GiteaSettingsSection() {
  const { giteaInstances } = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const [draft, setDraft] = useState<GiteaInstanceConfig | null>(null);
  return (
    <SettingsSection id="gitea-instances" title="Gitea instances">
      <p className="text-sm text-muted-foreground">
        Configure this server’s Gitea hosts for branch pull-request badges. Tokens stay on the
        server.
      </p>
      {[...giteaInstances, ...(draft ? [draft] : [])].map((instance) => (
        <GiteaInstanceForm
          key={`${instance.id}:${instance.token}:${instance.webOrigin}:${instance.host}`}
          instance={instance}
          save={async (value) => {
            await update({
              giteaInstances: [...giteaInstances.filter((item) => item.id !== value.id), value],
            });
            setDraft(null);
          }}
          remove={async () => {
            if (draft?.id === instance.id) setDraft(null);
            else
              await update({
                giteaInstances: giteaInstances.filter((item) => item.id !== instance.id),
              });
          }}
        />
      ))}
      <Button
        variant="outline"
        size="sm"
        disabled={draft !== null}
        onClick={() =>
          setDraft({
            id: randomUUID(),
            host: "",
            sshAliases: [],
            sshPorts: [22],
            webOrigin: "",
            apiOrigin: "",
            token: "",
          })
        }
      >
        Add Gitea instance
      </Button>
    </SettingsSection>
  );
}
