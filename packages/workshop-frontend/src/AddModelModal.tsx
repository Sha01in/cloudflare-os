import { useState, useEffect, useRef } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import {
  AiChatAuthorInfo,
  AiModelConfig,
  AiModelProvider,
  AiGatewayInfo,
  AiOAuthProvider,
  AiReasoningEffort,
  SUGGESTED_MODELS,
} from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  xai: 'xAI (Grok / SuperGrok)',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  xai: 'xai-...',
  ollama: '(optional)',
}

const OAUTH_PROVIDERS = new Set<AiModelProvider>(['xai'])

const EFFORT_OPTIONS: { value: AiReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

function isOAuthProvider(provider: AiModelProvider): provider is AiOAuthProvider {
  return OAUTH_PROVIDERS.has(provider)
}

function suggestedPrefersOAuth(provider: AiModelProvider, modelId: string): boolean {
  return !!SUGGESTED_MODELS[provider]?.[modelId]?.oauthPreferred
}

function defaultEffort(provider: AiModelProvider, modelId: string | undefined): AiReasoningEffort | undefined {
  if (!modelId) return undefined
  return SUGGESTED_MODELS[provider]?.[modelId]?.reasoningEffort
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    const oauthProvider = isOAuthProvider(provider)
    // Gateway mode hides non-enabled API-key providers, but subscription OAuth models stay
    // available because they bill the user's plan, not the gateway.
    if (enabledProviders && !enabledProviders.has(provider) && !oauthProvider) continue

    // In gateway mode, suggested API-key models are already built-in. Still list OAuth
    // subscription models so SuperGrok etc. can be added on top of gateway mode.
    if (!gatewayMode || oauthProvider) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort | undefined>(undefined)

  // OAuth / subscription sign-in
  const [useApiKeyFallback, setUseApiKeyFallback] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null)
  const [oauthVerificationUri, setOauthVerificationUri] = useState<string | null>(null)
  const oauthAttemptRef = useRef<{ [Symbol.dispose](): void } | null>(null)

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  const disposeOauthAttempt = () => {
    oauthAttemptRef.current?.[Symbol.dispose]()
    oauthAttemptRef.current = null
  }

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      disposeOauthAttempt()
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setReasoningEffort(undefined)
      setUseApiKeyFallback(false)
      setOauthBusy(false)
      setOauthUserCode(null)
      setOauthVerificationUri(null)
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  // Dispose any in-flight OAuth attempt on unmount.
  useEffect(() => () => disposeOauthAttempt(), [])

  const handleModelSelect = (value: string) => {
    disposeOauthAttempt()
    setOauthBusy(false)
    setOauthUserCode(null)
    setOauthVerificationUri(null)
    setUseApiKeyFallback(false)

    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
      setReasoningEffort(undefined)
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
      setReasoningEffort(defaultEffort(sel.provider, sel.modelId))
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const wantsOAuth =
    !!selection &&
    isOAuthProvider(selection.provider) &&
    !useApiKeyFallback &&
    (selection.type === 'custom' || suggestedPrefersOAuth(selection.provider, selection.modelId))

  const validate = (forOAuth = false): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode && !forOAuth && !wantsOAuth

    if (showCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = 'Please enter your API token'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const buildProfileAndConfig = (opts?: {
    oauth?: AiModelConfig['oauth']
    apiToken?: string
  }): { profile: AiChatAuthorInfo; config: AiModelConfig } => {
    const isSuggested = selection!.type === 'suggested'
    const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
    const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

    const profile: AiChatAuthorInfo = {
      type: 'agent',
      id: finalModelId,
      name: finalDisplayName,
    }

    const config: AiModelConfig = {
      provider: selection!.provider,
      model: finalModelId,
      apiToken: opts?.oauth ? '' : (gatewayMode ? '' : (opts?.apiToken ?? apiToken).trim()),
      ...(opts?.oauth ? { oauth: opts.oauth } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(!gatewayMode && !opts?.oauth && accountId.trim() && { accountId: accountId.trim() }),
      ...(!gatewayMode && !opts?.oauth && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
    }

    return { profile, config }
  }

  const handleSubmit = async () => {
    if (wantsOAuth) {
      await handleOAuthSignIn()
      return
    }

    if (!validate()) return

    setLoading(true)
    try {
      const { profile, config } = buildProfileAndConfig()
      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleOAuthSignIn = async () => {
    if (!selection || !isOAuthProvider(selection.provider)) return
    if (!validate(true)) return

    disposeOauthAttempt()
    setOauthBusy(true)
    setLoading(true)
    setErrors({})

    try {
      const { device, attempt } = await authenticatedApi.beginAiProviderOAuth(selection.provider)
      oauthAttemptRef.current = attempt
      setOauthUserCode(device.userCode)
      setOauthVerificationUri(device.verificationUri)

      // Open the provider verification page. User confirms the code (or completes if URI embeds it).
      window.open(device.verificationUri, '_blank', 'noopener,noreferrer')

      const oauth = await attempt.wait()
      const { profile, config } = buildProfileAndConfig({ oauth })
      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'Signed in and model added', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed SuperGrok OAuth:', error)
      const message = typeof error?.message === 'string' && error.message
        ? error.message
        : 'Failed to sign in with SuperGrok'
      // Cancellation from disposing the attempt is quiet enough as a toast.
      toasts.add({ title: message, variant: 'error' })
    } finally {
      disposeOauthAttempt()
      setOauthBusy(false)
      setLoading(false)
      setOauthUserCode(null)
      setOauthVerificationUri(null)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const isXai = selection?.provider === 'xai'
  const showCredentials = !gatewayMode && selection && (!wantsOAuth || useApiKeyFallback)
  const showEffort = isXai || selection?.provider === 'openai'

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? 'Select Model or Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a model or provider...' : 'Choose an AI model...'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            disabled={oauthBusy}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${example!.modelId}`}
                description={`The model identifier as specified by the provider (e.g., '${example!.modelId}')`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
                disabled={oauthBusy}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
                disabled={oauthBusy}
              />
            </>
          )}

          {/* Reasoning effort (Grok 4.5 / OpenAI Responses) */}
          {showEffort && selection && (
            <Select
              label="Reasoning effort"
              className="w-full text-sm"
              placeholder="Default"
              value={reasoningEffort}
              onValueChange={(v) => setReasoningEffort(v as AiReasoningEffort)}
              disabled={oauthBusy}
              description={
                isXai
                  ? 'SuperGrok Heavy can sustain high effort. Grok 4.5 defaults to high.'
                  : 'How hard the model thinks before answering.'
              }
              renderValue={(v) => EFFORT_OPTIONS.find(o => o.value === v)?.label ?? String(v)}
            >
              {EFFORT_OPTIONS.map(opt => (
                <Select.Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Select.Option>
              ))}
            </Select>
          )}

          {/* SuperGrok / subscription OAuth */}
          {wantsOAuth && (
            <div className="rounded-lg border border-kumo-line bg-kumo-tint/40 px-4 py-3 space-y-2">
              <p className="text-sm font-medium text-kumo-default">
                Sign in with SuperGrok or X Premium
              </p>
              <p className="text-xs text-kumo-subtle">
                Uses your xAI subscription (SuperGrok / SuperGrok Heavy / X Premium+). No API key needed.
              </p>
              {oauthUserCode && (
                <div className="rounded-md bg-kumo-base border border-kumo-line px-3 py-2">
                  <p className="text-xs text-kumo-subtle mb-1">Confirm this code if prompted:</p>
                  <p className="text-lg font-mono tracking-widest text-kumo-default">{oauthUserCode}</p>
                  {oauthVerificationUri && (
                    <a
                      href={oauthVerificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-kumo-brand hover:underline mt-1 inline-block"
                    >
                      Open verification page
                    </a>
                  )}
                </div>
              )}
              <button
                type="button"
                className="text-xs text-kumo-subtle hover:text-kumo-default underline"
                onClick={() => setUseApiKeyFallback(true)}
                disabled={oauthBusy}
              >
                Use an xAI API key instead
              </button>
            </div>
          )}

          {isOAuthProvider(selection?.provider as AiModelProvider) && useApiKeyFallback && (
            <button
              type="button"
              className="text-xs text-kumo-subtle hover:text-kumo-default underline"
              onClick={() => setUseApiKeyFallback(false)}
              disabled={oauthBusy}
            >
              Back to SuperGrok sign-in
            </button>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : isXai
                  ? 'Your xAI API key (console.x.ai). Prefer SuperGrok sign-in if you have a subscription.'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection || oauthBusy}
          >
            {wantsOAuth ? 'Sign in with SuperGrok' : 'Add Model'}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
