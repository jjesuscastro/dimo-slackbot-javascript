# Dimo Bot Retention Report and Proposal

**Prepared:** October 29, 2026  
**Source:** `dimo-stats-all-2026-10-29.csv`  
**Coverage:** 2,524 recorded file processing attempts, October 19–29, 2026 (timestamps grouped by their UTC date)

## Executive summary

The data supports keeping the Dimo bot in use as the team's routine pre-upload quality gate. During this export period, it successfully uploaded 2,277 files and stopped 247 files with validation problems. The checks caught recurring filename-format and vocabulary errors, as well as files missing `mraid.open` or containing `window.open`.

The figures show that the bot is actively processing team work and catching concrete rule violations. They do not measure the time saved, the number of issues that would have reached production without the bot, or the business impact of those issues. The export also contains no reserved click-name matches, so it cannot demonstrate the impact of the newly added `clickTag1`/`clickthrough` check.

## What the export shows

| Measure | Result |
| --- | ---: |
| Recorded attempts | 2,524 |
| Successful uploads | 2,277 (90.2%) |
| Rejected for validation | 247 (9.8%) |
| Upload failures after validation | 0 |
| Attempts with naming issues | 229 (9.1%) |
| Missing `mraid.open` | 11 (0.4%) |
| Contains `window.open` | 25 (1.0%) |
| Distinct uploader IDs | 25 |
| Distinct filenames | 971 |

Validation issue counts overlap: one rejected file may have more than one issue. The most frequent recorded issue groups were:

| Issue group | Rejected files mentioning it |
| --- | ---: |
| Filename has the wrong number of underscore-separated parts | 60 |
| Unsupported `concept2` value | 100 |
| Unsupported theme value | 57 |
| Contains `window.open` | 25 |
| Missing `mraid.open` | 11 |

The export has records on October 19–24 and 26–29; it has no October 25 records. October 29 contains only 10 attempts, so that day's 40% rejection rate is based on a small, likely incomplete sample. Daily rejection rates otherwise varied, ranging from 1.9% on October 21 to 18.7% on October 22. The variation suggests keeping the rules and reviewing recurring errors, rather than treating the overall rate as a stable forecast.

## Why keep using the bot

1. **It catches errors before upload.** The 247 validation failures represent files that did not proceed to PLEC until their issues were addressed. This includes 25 files with `window.open` and 11 without the required `mraid.open`.
2. **It applies shared naming and content rules consistently.** More than 2,500 attempts across 25 uploader IDs were processed through the same workflow, reducing reliance on each person remembering every naming and technical requirement.
3. **It leaves an operational record.** The export records filenames, uploader snapshots, outcomes, and issue details. That makes it possible to see which rules generate repeat corrections and where documentation or allowed values may need attention.
4. **It supports a substantial, varied workload.** The 2,524 attempts covered 971 distinct filenames, indicating the bot is part of regular production work rather than an occasional utility.

These are operational reasons supported by the export. The CSV does not quantify minutes saved, avoided downstream incidents, or cost savings, so those should not be claimed without further measurement.

## Proposal

**Continue using the Dimo bot as the standard pre-upload path for HTML creative files.** Keep the filename, `window.open`, and `mraid.open` checks active, and retain the new reserved click-name check so it can be assessed in future exports.

For the next review period:

- Review the 100 `concept2` and 57 theme-related validation failures against the current supported-value list. If valid production terminology is being rejected, update the list; otherwise, make those rules easier to find in the team's submission guidance.
- Use the 60 wrong-part-count failures to reinforce the expected filename template, especially for new or infrequent uploaders.
- Add a dedicated statistics field or report count for reserved click identifiers. The current export has no click-name matches in `issue_details`, so it cannot measure this check's catch rate.
- Compare the next 30 days with this baseline using attempts, validation-failure rate, repeat issue categories, and successful uploads. Track correction time separately if the team wants to quantify time saved.

## Recommendation

Keep the bot. Its current data shows broad use and hundreds of concrete validation catches, with no recorded PLEC upload failures among the attempts that passed validation. Review the high-volume naming and vocabulary errors to improve guidance, then use the next month's data to evaluate whether the checks are reducing repeat failures and whether the reserved click-name rule is catching additional issues.

## Measurement notes

- Percentages use 2,524 recorded attempts as the denominator and are rounded to one decimal place.
- Issue-group totals are counts of validation-failure rows containing each issue text; rows can appear in more than one group.
- The export has no `clickTag1`/`clickthrough` error details. This may be because the check was added after the recorded attempts or because it did not trigger; the CSV alone cannot distinguish those cases.
- The export reflects recorded attempts, not necessarily every file skipped when another file in the same batch failed validation.
