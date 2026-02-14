import { type RunOptions, run } from "@grammyjs/runner";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  webhookHost?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Enforce 30-second timeout more strictly
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Reduce retry time to prevent long hangs before our own retry logic takes over
      maxRetryTime: 2 * 60 * 1000, // 2 minutes instead of 5
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const MAX_RESTART_ATTEMPTS = 20; // Prevent infinite retry loops

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

const isTimeoutAbortError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }

  // Walk the error cause chain looking for timeout-specific indicators
  let current: any = err;
  while (current) {
    const code = current.code;
    const name = current.name;
    const message = current.message ? String(current.message).toLowerCase() : "";

    // Check for timeout-specific error codes from undici/Node.js
    if (
      code === "ETIMEDOUT" ||
      code === "ESOCKETTIMEDOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return true;
    }

    // Check for TimeoutError name (common in undici/AbortSignal chains)
    if (name === "TimeoutError") {
      return true;
    }

    // Fall back to message heuristic if code/name don't match
    if (message.includes("timeout") || message.includes("timed out")) {
      return true;
    }

    current = current.cause;
  }
  return false;
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;

  // Register handler for Grammy HttpError unhandled rejections.
  // This catches network errors that escape the polling loop's try-catch
  // (e.g., from setMyCommands during bot setup).
  // We gate on isGrammyHttpError to avoid suppressing non-Telegram errors.
  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    if (isGrammyHttpError(err) && isRecoverableTelegramNetworkError(err, { context: "polling" })) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true; // handled - don't crash
    }
    return false;
  });

  try {
    const cfg = opts.config ?? loadConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

    let lastUpdateId = await readTelegramUpdateOffset({
      accountId: account.accountId,
    });
    const persistUpdateId = async (updateId: number) => {
      if (lastUpdateId !== null && updateId <= lastUpdateId) {
        return;
      }
      lastUpdateId = updateId;
      try {
        await writeTelegramUpdateOffset({
          accountId: account.accountId,
          updateId,
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`,
        );
      }
    };

    const bot = createTelegramBot({
      token,
      runtime: opts.runtime,
      proxyFetch,
      config: cfg,
      accountId: account.accountId,
      updateOffset: {
        lastUpdateId,
        onUpdateId: persistUpdateId,
      },
    });

    if (opts.useWebhook) {
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret,
        host: opts.webhookHost ?? account.config.webhookHost,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
      });
      return;
    }

    // Use grammyjs/runner for concurrent update processing
    let restartAttempts = 0;

    while (!opts.abortSignal?.aborted) {
      const runner = run(bot, createTelegramRunnerOptions(cfg));
      const stopOnAbort = () => {
        if (opts.abortSignal?.aborted) {
          void runner.stop();
        }
      };
      opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        // runner.task() returns a promise that resolves when the runner stops
        await runner.task();
        return;
      } catch (err) {
        // Check if we're actually being aborted vs. a timeout/network error
        const isActualAbort = opts.abortSignal?.aborted === true;

        if (isActualAbort) {
          // Let callers' .catch() handler see the error during shutdown
          throw err;
        }

        const isConflict = isGetUpdatesConflict(err);
        const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
        const isTimeout = isTimeoutAbortError(err);

        // Treat timeout AbortErrors as recoverable network errors
        const shouldRetry = isConflict || isRecoverable || isTimeout;

        if (!shouldRetry) {
          throw err;
        }

        // Prevent infinite retry loops
        if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
          const errMsg = formatErrorMessage(err);
          (opts.runtime?.error ?? console.error)(
            `Telegram monitor: maximum restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded: ${errMsg}`,
          );
          throw err;
        }

        restartAttempts += 1;

        let reason = "network error";
        if (isConflict) reason = "getUpdates conflict";
        else if (isTimeout) reason = "request timeout";

        const errMsg = formatErrorMessage(err);
        const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
        (opts.runtime?.error ?? console.error)(
          `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationPrecise(delayMs)} (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}).`,
        );

        // Stop the current runner before retrying
        try {
          await runner.stop();
        } catch {
          // Ignore runner stop errors
        }

        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch (sleepErr) {
          if (opts.abortSignal?.aborted) {
            return;
          }
          throw sleepErr;
        }
      } finally {
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      }
    }
  } finally {
    unregisterHandler();
  }
}
