// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, createContext, useContext, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AiModelConfig, AiGatewayInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Selection = createContext<(value: string) => void>(() => {})
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>
  const Dialog = Object.assign(Box, { Root: Box, Title: Box, Close: () => null })
  const Select = Object.assign(
    ({ label, value, onValueChange, children }: {
      label: string, value?: string, onValueChange: (value: string) => void, children: ReactNode,
    }) => <fieldset aria-label={label} data-selection={value}>
      <Selection.Provider value={onValueChange}>{children}</Selection.Provider>
    </fieldset>,
    { Option: ({ value, children }: { value: string, children: ReactNode }) => {
      const selectValue = useContext(Selection)
      return <button type="button" data-value={value} onClick={() => selectValue(value)}>{children}</button>
    } },
  )
  return {
    Dialog, Select,
    Input: ({ label, value, onChange }: ComponentProps<'input'> & { label: string }) =>
      <input aria-label={label} value={value} onChange={onChange} />,
    SensitiveInput: ({ label, value, onValueChange }: {
      label: string, value: string, onValueChange: (value: string) => void,
    }) => <input aria-label={label} value={value} onChange={e => onValueChange(e.target.value)} />,
    Button: ({ children, onClick, disabled }: ComponentProps<'button'>) =>
      <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
    Collapsible: { Root: Box, DefaultTrigger: Box, DefaultPanel: Box },
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import AddModelModal from './AddModelModal'

const aiConfig: AiGatewayInfo = {
  enabled: false,
  reasoningEfforts: {
    xai: { 'grok-4.7': ['low', 'medium', 'high', 'xhigh'], 'grok-4.6': ['low', 'medium', 'high', 'xhigh'], 'grok-4.5': ['low', 'medium', 'high'] },
    openai: { 'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  },
}
let root: Root
let container: HTMLDivElement
const addModel = vi.fn<(profile: AiChatAuthorInfo, config: AiModelConfig) => Promise<void>>(async () => {})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  addModel.mockClear()
})

async function mount(config: AiGatewayInfo = aiConfig) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AddModelModal visible onCancel={() => {}} onSuccess={() => {}}
    authenticatedApi={{ addModel } as unknown as RpcStub<AuthenticatedApi>} aiConfig={config} />))
}

async function choose(label: string, value: string) {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"] [data-value="${value}"]`)!
  expect(button).not.toBeNull()
  await act(async () => button.click())
}

function efforts() {
  return Array.from(container.querySelectorAll<HTMLElement>('[aria-label="Reasoning effort"] [data-value]'))
    .map(option => option.dataset.value)
}

async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('model-specific effort selector', () => {
  it.each(['grok-4.6', 'grok-4.7'])('offers xhigh for %s, removes it on 4.5, and includes OpenAI-only choices', async model => {
    await mount()
    await choose('Select Model', `xai:${model}`)
    expect(efforts()).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
    await choose('Reasoning effort', 'xhigh')
    await choose('Select Model', 'xai:grok-4.5')
    expect(efforts()).toEqual(['default', 'low', 'medium', 'high'])
    expect(container.querySelector('[aria-label="Reasoning effort"]')?.getAttribute('data-selection')).toBe('high')
    await choose('Select Model', 'openai:gpt-5.6-sol')
    expect(efforts()).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it.each(['grok-4.6', 'grok-4.7'])('submits %s xhigh and lets users return to the model default', async model => {
    await mount()
    await choose('Select Model', `xai:${model}`)
    await choose('Reasoning effort', 'xhigh')
    const fallback = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Use an xAI API key instead')!
    await act(async () => fallback.click())
    await input('API Token', 'test-key')
    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Add Model')!
    await act(async () => submit.click())
    expect(addModel.mock.calls[0]?.[1]).toMatchObject({ model, reasoningEffort: 'xhigh' })
    await choose('Reasoning effort', 'default')
    await act(async () => submit.click())
    expect(addModel.mock.calls[1]?.[1]).not.toHaveProperty('reasoningEffort')
  })

  it('recognizes custom model IDs and clears effort when changing to an unknown model', async () => {
    await mount()
    await choose('Select Model', 'other-xai')
    await input('Model ID', 'grok-4.6')
    expect(efforts()).toContain('xhigh')
    await choose('Reasoning effort', 'xhigh')
    await input('Model ID', 'unknown-model')
    expect(efforts()).toEqual([])
    await input('Model ID', 'grok-4.6')
    expect(container.querySelector('[aria-label="Reasoning effort"]')?.getAttribute('data-selection')).toBe('default')
  })

  it('does not invent options when an older server has no capability metadata', async () => {
    await mount({ enabled: false })
    await choose('Select Model', 'xai:grok-4.6')
    expect(efforts()).toEqual([])
  })
})
