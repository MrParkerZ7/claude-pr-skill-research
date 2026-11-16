package io.github.mrparkerz7.prskill.api.probe

/**
 * Turns a title into a URL slug: lower case, its words joined by single hyphens.
 *
 * A probe for the master's T-060, which proves the soft-pr commands on a real pull request. Its pull request is
 * closed unmerged.
 */
fun slugOf(title: String): String = title.lowercase().split(" ").joinToString("-")
