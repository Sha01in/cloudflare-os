using Workerd = import "/workerd/workerd.capnp";
using Bundles = import "./dist/modules.capnp";

# Standalone Cloudflare OS topology. Worker bundles and Bundles.*Modules are produced by
# `pnpm workerd:build`; paths below are relative to the repository root, where workerd is run.
const config :Workerd.Config = (
  services = [
    # Durable Object SQLite files, fake KV/R2 payloads, and the built frontend respectively.
    (name = "durable-object-storage",
      disk = (path = "workerd/state/durable-objects", writable = true)),
    (name = "object-storage",
      disk = (path = "workerd/state/objects", writable = true)),
    (name = "frontend-assets",
      disk = (path = "packages/workshop-frontend/dist")),

    # workerd does not provide Cloudflare's hosted AI, KV, R2, or assets bindings. This Worker
    # exposes the subset Cloudflare OS uses through ordinary, locally-defined JSRPC entrypoints.
    (name = "platform-services",
      worker = (
        modules = [
          (name = "platform-services.js", esModule = embed "platform-services.js")
        ],
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "DATA", service = "object-storage"),
          (name = "ASSETS", service = "frontend-assets")
        ],
        durableObjectNamespaces = [
          (className = "PlatformStorage",
            uniqueKey = "cloudflare-os--platform-services--PlatformStorage--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "router",
      worker = (
        modules = Bundles.routerModules,
        compatibilityDate = "2026-09-04",
        bindings = [
          (name = "WORKSHOP_BACKEND", service = "workshop-backend"),
          (name = "ASSETS",
            service = (name = "platform-services", entrypoint = "StaticAssets")),
          (name = "GATEKEEPER_CLOUDFLARE", service = "gatekeeper-cloudflare"),
          (name = "GATEKEEPER_CONFLUENCE", service = "gatekeeper-confluence"),
          (name = "GATEKEEPER_CONTEXT", service = "gatekeeper-context"),
          (name = "GATEKEEPER_EMAIL", service = "gatekeeper-email"),
          (name = "GATEKEEPER_GITHUB", service = "gatekeeper-github"),
          (name = "GATEKEEPER_GOOGLE", service = "gatekeeper-google"),
          (name = "GATEKEEPER_HOMEASSISTANT", service = "gatekeeper-homeassistant"),
          (name = "GATEKEEPER_LINEAR", service = "gatekeeper-linear"),
          (name = "GATEKEEPER_MCP", service = "gatekeeper-mcp"),
          (name = "GATEKEEPER_MCP_PORTAL", service = "gatekeeper-mcp-portal"),
          (name = "GATEKEEPER_NOTION", service = "gatekeeper-notion"),
          (name = "GATEKEEPER_SCHEDULER", service = "gatekeeper-scheduler"),
          (name = "GATEKEEPER_SLACK", service = "gatekeeper-slack"),
          (name = "GATEKEEPER_SPOTIFY", service = "gatekeeper-spotify"),
          (name = "GATEKEEPER_SUPABASE", service = "gatekeeper-supabase"),
          (name = "GATEKEEPER_ZOOMINFO", service = "gatekeeper-zoominfo")
        ]
      )),

    (name = "workshop-backend",
      worker = (
        modules = Bundles.workshopBackendModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = [
          "allow_irrevocable_stub_storage",
          "global_fetch_strictly_public",
          "nodejs_compat"
        ],
        bindings = [
          (name = "ADMINS", fromEnvironment = "ADMINS"),
          (name = "PUBLIC_BASE_URL", fromEnvironment = "PUBLIC_BASE_URL"),
          (name = "AUTH_GATEKEEPERS", fromEnvironment = "AUTH_GATEKEEPERS"),
          (name = "DISABLE_PASSWORD_AUTH", fromEnvironment = "DISABLE_PASSWORD_AUTH"),
          (name = "CF_AI_GATEWAY", fromEnvironment = "CF_AI_GATEWAY"),
          (name = "CF_AI_GATEWAY_PROVIDERS", fromEnvironment = "CF_AI_GATEWAY_PROVIDERS"),
          (name = "CF_AI_GATEWAY_ACCOUNT_ID", fromEnvironment = "CF_AI_GATEWAY_ACCOUNT_ID"),
          (name = "CF_AI_GATEWAY_API_TOKEN", fromEnvironment = "CF_AI_GATEWAY_API_TOKEN"),
          (name = "CF_AI_GATEWAY_USE_BINDING", fromEnvironment = "CF_AI_GATEWAY_USE_BINDING"),
          (name = "DAILY_LLM_CALL_LIMIT", fromEnvironment = "DAILY_LLM_CALL_LIMIT"),
          (name = "ENABLE_CLOUDFLARE_LIMITS", fromEnvironment = "ENABLE_CLOUDFLARE_LIMITS"),
          (name = "MINIMUM_CLOUDFLARE_BALANCE", fromEnvironment = "MINIMUM_CLOUDFLARE_BALANCE"),
          (name = "CF_ACCESS_AUD", fromEnvironment = "CF_ACCESS_AUD"),
          (name = "CF_ACCESS_ISS", fromEnvironment = "CF_ACCESS_ISS"),
          (name = "BLUEPRINTS",
            service = (name = "platform-services", entrypoint = "KvNamespace",
              props = (json = "{\"namespace\":\"blueprints\"}"))),
          (name = "AVATARS",
            service = (name = "platform-services", entrypoint = "KvNamespace",
              props = (json = "{\"namespace\":\"avatars\"}"))),
          (name = "BLUEPRINT_CONTENT",
            service = (name = "platform-services", entrypoint = "R2Bucket",
              props = (json = "{\"namespace\":\"blueprint-content\"}"))),
          (name = "WORKERS_AI",
            service = (name = "platform-services", entrypoint = "WorkersAi")),
          (name = "LOADER", workerLoader = (id = "cloudflare-os-gadgets")),
          (name = "GATEKEEPER_CLOUDFLARE",
            service = (name = "gatekeeper-cloudflare", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_CONFLUENCE",
            service = (name = "gatekeeper-confluence", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_CONTEXT",
            service = (name = "gatekeeper-context", entrypoint = "GatekeeperVendor",
              props = (json = "{\"sharingDomain\":\"self-hosted\"}"))),
          (name = "GATEKEEPER_EMAIL",
            service = (name = "gatekeeper-email", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_GITHUB",
            service = (name = "gatekeeper-github", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_GOOGLE",
            service = (name = "gatekeeper-google", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_HOMEASSISTANT",
            service = (name = "gatekeeper-homeassistant", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_LINEAR",
            service = (name = "gatekeeper-linear", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_MCP",
            service = (name = "gatekeeper-mcp", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_MCP_PORTAL",
            service = (name = "gatekeeper-mcp-portal", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_NOTION",
            service = (name = "gatekeeper-notion", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_SCHEDULER",
            service = (name = "gatekeeper-scheduler", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_SLACK",
            service = (name = "gatekeeper-slack", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_SPOTIFY",
            service = (name = "gatekeeper-spotify", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_SUPABASE",
            service = (name = "gatekeeper-supabase", entrypoint = "GatekeeperVendor")),
          (name = "GATEKEEPER_ZOOMINFO",
            service = (name = "gatekeeper-zoominfo", entrypoint = "GatekeeperVendor"))
        ],
        durableObjectNamespaces = [
          (className = "UserDurableObject",
            uniqueKey = "cloudflare-os--workshop-backend--UserDurableObject--v1", enableSql = true),
          (className = "OverseerDurableObject",
            uniqueKey = "cloudflare-os--workshop-backend--OverseerDurableObject--v1", enableSql = true),
          (className = "AdminSettings",
            uniqueKey = "cloudflare-os--workshop-backend--AdminSettings--v1", enableSql = true),
          (className = "PendingLogin",
            uniqueKey = "cloudflare-os--workshop-backend--PendingLogin--v1", enableSql = true),
          (className = "UserDirectoryDurableObject",
            uniqueKey = "cloudflare-os--workshop-backend--UserDirectoryDurableObject--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-cloudflare",
      worker = (
        modules = Bundles.gatekeeperCloudflareModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_CLOUDFLARE_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "CLOUDFLARE_OAUTH_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "CLOUDFLARE_OAUTH_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-cloudflare--UserAccount--v1", enableSql = true),
          (className = "CloudflareObservabilityGatekeeper",
            uniqueKey = "cloudflare-os--gatekeeper-cloudflare--CloudflareObservabilityGatekeeper--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-confluence",
      worker = (
        modules = Bundles.gatekeeperConfluenceModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_CONFLUENCE_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "CONFLUENCE_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "CONFLUENCE_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-confluence--UserAccount--v1", enableSql = true),
          (className = "ConfluenceSiteGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-confluence--ConfluenceSiteGatekeeperImpl--v1",
            enableSql = true),
          (className = "ConfluenceSpaceGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-confluence--ConfluenceSpaceGatekeeperImpl--v1",
            enableSql = true),
          (className = "ConfluenceContentGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-confluence--ConfluenceContentGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-context",
      worker = (
        modules = Bundles.gatekeeperContextModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["nodejs_compat", "allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_CONTEXT_BASE_URL"),
          (name = "CONTEXT_COLLECTIONS",
            service = (name = "platform-services", entrypoint = "KvNamespace",
              props = (json = "{\"namespace\":\"context-collections\"}")))
        ],
        durableObjectNamespaces = [
          (className = "ContextCollectionDurableObject",
            uniqueKey = "cloudflare-os--gatekeeper-context--ContextCollectionDurableObject--v1",
            enableSql = true),
          (className = "UserLibraryDurableObject",
            uniqueKey = "cloudflare-os--gatekeeper-context--UserLibraryDurableObject--v1",
            enableSql = true),
          (className = "LibraryRegistryDurableObject",
            uniqueKey = "cloudflare-os--gatekeeper-context--LibraryRegistryDurableObject--v1",
            enableSql = true),
          (className = "ContextGatekeeper",
            uniqueKey = "cloudflare-os--gatekeeper-context--ContextGatekeeper--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-email",
      worker = (
        modules = Bundles.gatekeeperEmailModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_EMAIL_BASE_URL")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-email--UserAccount--v1", enableSql = true),
          (className = "EmailGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-email--EmailGatekeeperImpl--v1", enableSql = true),
          (className = "EmailAddress",
            uniqueKey = "cloudflare-os--gatekeeper-email--EmailAddress--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-github",
      worker = (
        modules = Bundles.gatekeeperGithubModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_GITHUB_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "GITHUB_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "GITHUB_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-github--UserAccount--v1", enableSql = true),
          (className = "GitHubGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-github--GitHubGatekeeperImpl--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-google",
      worker = (
        modules = Bundles.gatekeeperGoogleModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_GOOGLE_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "GOOGLE_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "GOOGLE_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-google--UserAccount--v1", enableSql = true),
          (className = "GmailGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--GmailGatekeeperImpl--v1", enableSql = true),
          (className = "BigQueryGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--BigQueryGatekeeperImpl--v1", enableSql = true),
          (className = "GoogleCalendarGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--GoogleCalendarGatekeeperImpl--v1",
            enableSql = true),
          (className = "GoogleSheetsGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--GoogleSheetsGatekeeperImpl--v1", enableSql = true),
          (className = "GoogleDriveGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--GoogleDriveGatekeeperImpl--v1", enableSql = true),
          (className = "GoogleDocGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-google--GoogleDocGatekeeperImpl--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-homeassistant",
      worker = (
        modules = Bundles.gatekeeperHomeassistantModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_HOMEASSISTANT_BASE_URL")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-homeassistant--UserAccount--v1", enableSql = true),
          (className = "HomeAssistantGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-homeassistant--HomeAssistantGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-linear",
      worker = (
        modules = Bundles.gatekeeperLinearModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_LINEAR_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "LINEAR_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "LINEAR_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-linear--UserAccount--v1", enableSql = true),
          (className = "LinearGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-linear--LinearGatekeeperImpl--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-mcp",
      worker = (
        modules = Bundles.gatekeeperMcpModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_MCP_BASE_URL"),
          (name = "MCP_ALLOW_INSECURE", text = "false")
        ],
        durableObjectNamespaces = [
          (className = "McpAccount",
            uniqueKey = "cloudflare-os--gatekeeper-mcp--McpAccount--v1", enableSql = true),
          (className = "McpGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-mcp--McpGatekeeperImpl--v1", enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-mcp-portal",
      worker = (
        modules = Bundles.gatekeeperMcpPortalModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_MCP_PORTAL_BASE_URL"),
          (name = "MCP_ALLOW_INSECURE", text = "false"),
          (name = "MCP_PORTAL_URL", fromEnvironment = "MCP_PORTAL_URL"),
          (name = "MCP_PORTAL_NAME", fromEnvironment = "MCP_PORTAL_NAME"),
          (name = "MCP_PORTAL_AUTH", fromEnvironment = "MCP_PORTAL_AUTH"),
          (name = "MCP_PORTAL_TOKEN", fromEnvironment = "MCP_PORTAL_TOKEN"),
          (name = "MCP_PORTAL_TRUST_ANNOTATIONS",
            fromEnvironment = "MCP_PORTAL_TRUST_ANNOTATIONS"),
          (name = "MCP_PORTAL_HIDDEN_SERVER_IDS",
            fromEnvironment = "MCP_PORTAL_HIDDEN_SERVER_IDS")
        ],
        durableObjectNamespaces = [
          (className = "McpAccount",
            uniqueKey = "cloudflare-os--gatekeeper-mcp-portal--McpAccount--v1", enableSql = true),
          (className = "McpGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-mcp-portal--McpGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-notion",
      worker = (
        modules = Bundles.gatekeeperNotionModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_NOTION_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "NOTION_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "NOTION_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-notion--UserAccount--v1", enableSql = true),
          (className = "NotionItemGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-notion--NotionItemGatekeeperImpl--v1",
            enableSql = true),
          (className = "NotionWorkspaceGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-notion--NotionWorkspaceGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-scheduler",
      worker = (
        modules = Bundles.gatekeeperSchedulerModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_SCHEDULER_BASE_URL")
        ],
        durableObjectNamespaces = [
          (className = "ScheduleDriver",
            uniqueKey = "cloudflare-os--gatekeeper-scheduler--ScheduleDriver--v1", enableSql = true),
          (className = "SchedulerGatekeeper",
            uniqueKey = "cloudflare-os--gatekeeper-scheduler--SchedulerGatekeeper--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-slack",
      worker = (
        modules = Bundles.gatekeeperSlackModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_SLACK_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "SLACK_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "SLACK_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-slack--UserAccount--v1", enableSql = true),
          (className = "SlackWorkspaceGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-slack--SlackWorkspaceGatekeeperImpl--v1",
            enableSql = true),
          (className = "SlackConversationGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-slack--SlackConversationGatekeeperImpl--v1",
            enableSql = true),
          (className = "SlackThreadGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-slack--SlackThreadGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-spotify",
      worker = (
        modules = Bundles.gatekeeperSpotifyModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_SPOTIFY_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "SPOTIFY_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "SPOTIFY_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-spotify--UserAccount--v1", enableSql = true),
          (className = "SpotifyGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-spotify--SpotifyGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-supabase",
      worker = (
        modules = Bundles.gatekeeperSupabaseModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_SUPABASE_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "SUPABASE_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "SUPABASE_CLIENT_SECRET")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-supabase--UserAccount--v1", enableSql = true),
          (className = "SupabaseGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-supabase--SupabaseGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "gatekeeper-zoominfo",
      worker = (
        modules = Bundles.gatekeeperZoominfoModules,
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "BASE_URL", fromEnvironment = "GATEKEEPER_ZOOMINFO_BASE_URL"),
          (name = "CLIENT_ID", fromEnvironment = "ZOOMINFO_CLIENT_ID"),
          (name = "CLIENT_SECRET", fromEnvironment = "ZOOMINFO_CLIENT_SECRET"),
          (name = "ZOOMINFO_API_BASE_URL", fromEnvironment = "ZOOMINFO_API_BASE_URL")
        ],
        durableObjectNamespaces = [
          (className = "UserAccount",
            uniqueKey = "cloudflare-os--gatekeeper-zoominfo--UserAccount--v1", enableSql = true),
          (className = "ZoomInfoGatekeeperImpl",
            uniqueKey = "cloudflare-os--gatekeeper-zoominfo--ZoomInfoGatekeeperImpl--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      ))
  ],
  sockets = [
    (name = "http", address = "*:8787", http = (), service = "router")
  ]
);
