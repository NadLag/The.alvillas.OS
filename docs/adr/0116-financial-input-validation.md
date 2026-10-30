# ADR 0116: Reject incomplete money before financial evaluation

Status: Accepted for integration; feature and staging acceptance remain outstanding.

A fixed monetary approval threshold requires an explicit currency. Previously the configuration schema accepted an amount without one, while the evaluator correctly compared fixed amounts only in the same currency. That incomplete rule silently matched no approval stage. Configuration validation now rejects it. Currency matching, configured approval steps and non-monetary percentage or unconditional rules retain their existing semantics. No organization-currency fallback or threshold value is invented, and no stored financial history is rewritten.

Financial transfer amount syntax now completes before Decimal refinement or normalization runs. Malformed input produces the declared validation result rather than a Decimal exception escaping safeParse. Positive exact values, supported precision, account separation and currency checks retain their existing behavior. Regression tests reproduce both original failures and preserve the successful and rejected boundary cases.
