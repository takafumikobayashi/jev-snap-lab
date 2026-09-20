/**
 * アプリ側の best-effort レート制限。
 *
 * 判定 API は上流に課金が発生するため、公開前に必ず入れる。ただし
 * serverless ではインスタンスを跨いで状態を共有しないので、**完全な
 * 制限にはならない**。踏み台からの大量アクセスを止める手段ではなく、
 * 素朴な連打と事故を抑えるためのもの（docs/ARCHITECTURE.md §9）。
 *
 * 時計を引数で受け取り、経過時間に依存するテストを書けるようにしている。
 */

export type RateLimitDecision = {
	allowed: boolean;
	/** 拒否したとき、次に試せるまでの秒数。`Retry-After` に使う。 */
	retryAfterSeconds: number;
	/** 残りトークン数。観測ログ用。 */
	remaining: number;
};

export type RateLimiterOptions = {
	/** 時間窓あたりに許す回数。 */
	limit: number;
	/** 時間窓の長さ（ミリ秒）。 */
	windowMs: number;
	/**
	 * 追跡するキーの上限。
	 *
	 * 送信元アドレスは詐称できるため、無制限に覚えるとメモリを食い尽くす
	 * 経路になる。上限に達したら最も古いものから捨てる。
	 */
	maxKeys: number;
};

export const DEFAULT_OPTIONS: RateLimiterOptions = {
	limit: 10,
	windowMs: 60_000,
	maxKeys: 10_000
};

type Bucket = {
	tokens: number;
	/** 最後にトークンを補充した時刻。 */
	refilledAt: number;
};

export type RateLimiter = {
	check(key: string, now: number): RateLimitDecision;
	/** 観測ログ用。追跡中のキー数。 */
	size(): number;
};

/**
 * トークンバケット方式のレート制限を作る。
 *
 * 固定窓だと窓の境界で2倍の流量を許してしまうため、経過時間に比例して
 * 補充する方式にする。
 */
export function createRateLimiter(options: Partial<RateLimiterOptions> = {}): RateLimiter {
	const { limit, windowMs, maxKeys } = { ...DEFAULT_OPTIONS, ...options };
	const refillPerMs = limit / windowMs;
	const buckets = new Map<string, Bucket>();

	return {
		check(key, now) {
			const existing = buckets.get(key);
			const bucket: Bucket = existing ?? { tokens: limit, refilledAt: now };

			if (existing) {
				const elapsed = Math.max(0, now - existing.refilledAt);
				bucket.tokens = Math.min(limit, existing.tokens + elapsed * refillPerMs);
				bucket.refilledAt = now;
				// Map の挿入順を更新し、古いものから捨てられるようにする。
				buckets.delete(key);
			}

			const allowed = bucket.tokens >= 1;
			if (allowed) bucket.tokens -= 1;

			buckets.set(key, bucket);

			if (buckets.size > maxKeys) {
				const oldest = buckets.keys().next();
				if (!oldest.done) buckets.delete(oldest.value);
			}

			return {
				allowed,
				// 次の1トークンが貯まるまでの時間。切り上げて 1 秒以上にする。
				retryAfterSeconds: allowed
					? 0
					: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
				remaining: Math.floor(bucket.tokens)
			};
		},
		size() {
			return buckets.size;
		}
	};
}

/**
 * `APP_RATE_LIMIT_PER_MINUTE` を読む。
 *
 * 未設定なら既定値を使う。これは正常な運用。一方、設定してあるのに読めない
 * 値（`2/min`、`0`、`-1`、`abc`）は設定ミスであり、黙って既定の 10 件/分へ
 * 戻すと「課金保護のつもりで絞ったのに効いていない」に気付けない。
 * 区別できるように invalid を返し、呼び出し側が警告を残す。
 */
export function parseRateLimit(raw: string | undefined): { limit: number; invalid: boolean } {
	const trimmed = raw?.trim();
	if (!trimmed) return { limit: DEFAULT_OPTIONS.limit, invalid: false };

	const parsed = Number(trimmed);
	// 件数なので正の整数だけ受ける。2.5 件/分は意図の読み取りようがない。
	if (Number.isInteger(parsed) && parsed > 0) return { limit: parsed, invalid: false };

	return { limit: DEFAULT_OPTIONS.limit, invalid: true };
}
