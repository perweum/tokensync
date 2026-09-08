---
name: code-review
description: Review code for simplification and reduction. Identify redundant logic, unnecessary complexity, and opportunities to streamline code.
disable-model-invocation: true
---

Review the following path for code simplification & reduction. Redundant logic, code that can be written simpler. Unneeded complex flows. The code is always used in a certain way, so we don't need to cover every possible edge case.
Are there any cases that can't really occur that we can remove or simplify? Are there any variables that we can drop since the logic doesn't need them? Are there any ifs that could be asserts instead? A bit of duplication is better than extra functions/abstractions. Less lines of code is usually better.
