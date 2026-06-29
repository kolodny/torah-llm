// "Custom plugins" — a Storage-page section to load third-party external plugin bundles by URL at runtime.
// URLs persist in localStorage and auto-load on every startup (after the first-party plugins). A newly added
// plugin loads immediately — if it registers a page, the nav tab appears at once (the registry is reactive).
// SECURITY: these bundles run in the host's origin with full access. Only add URLs you trust.
import { useState } from 'react';
import { Stack, Group, Text, TextInput, Button, ActionIcon, Alert, Anchor, Code } from '@mantine/core';
import { getUserPluginUrls, addUserPlugin, removeUserPlugin } from '../plugins/host';

export default function CustomPlugins() {
  const [urls, setUrls] = useState<string[]>(() => getUserPluginUrls());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const add = async () => {
    const url = input.trim();
    if (!url) return;
    if (urls.includes(url)) {
      setError('That URL is already added.');
      return;
    }
    setBusy(true);
    setError(null);
    setJustAdded(null);
    try {
      const id = await addUserPlugin(url); // loads the bundle now; only persists if it registers cleanly
      setUrls(getUserPluginUrls());
      setInput('');
      setJustAdded(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (url: string) => {
    removeUserPlugin(url);
    setUrls(getUserPluginUrls());
    if (justAdded) setJustAdded(null);
  };

  return (
    <Stack gap="xs" className="custom-plugins" mt="lg">
      <Text fw={700} size="lg">Custom plugins</Text>
      <Text size="sm" c="dimmed">
        Load a third-party plugin from a URL to its built bundle (one IIFE <Code>.js</Code> — see{' '}
        <Anchor href="https://github.com/kolodny/torah-llm/blob/main/PLUGINS.md" target="_blank" rel="noreferrer">PLUGINS.md</Anchor>).
        Added plugins are remembered and reload on every visit.
      </Text>
      <Alert color="yellow" variant="light" p="xs">
        <Text size="xs">
          Plugins run in this app’s origin with full access to your data — only add bundles you trust.
        </Text>
      </Alert>

      <Group align="flex-start" gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder="https://example.com/my-plugin.js"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          error={error ?? undefined}
          disabled={busy}
        />
        <Button color="orange" onClick={() => void add()} loading={busy} disabled={!input.trim()}>
          Add
        </Button>
      </Group>
      {justAdded && <Text size="sm" c="green">Loaded plugin “{justAdded}”.</Text>}

      {urls.length === 0 ? (
        <Text size="sm" c="dimmed">No custom plugins added.</Text>
      ) : (
        <Stack gap={4}>
          {urls.map((url) => (
            <Group key={url} justify="space-between" wrap="nowrap" gap="xs">
              <Anchor href={url} target="_blank" rel="noreferrer" size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {url}
              </Anchor>
              <ActionIcon size="sm" variant="subtle" color="red" aria-label="Remove plugin" onClick={() => remove(url)}>×</ActionIcon>
            </Group>
          ))}
          <Text size="xs" c="dimmed">Removing forgets the URL; an already-loaded plugin stays active until you reload.</Text>
        </Stack>
      )}
    </Stack>
  );
}
