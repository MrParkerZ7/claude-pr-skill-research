import kotlinx.kover.gradle.plugin.dsl.CoverageUnit

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.spring)
    alias(libs.plugins.spring.boot)
    alias(libs.plugins.spring.dependency.management)
    alias(libs.plugins.spotless)
    alias(libs.plugins.kover)
}

group = "io.github.mrparkerz7.prskill"

repositories {
    mavenCentral()
}

dependencies {
    implementation(libs.spring.boot.starter.actuator)
    implementation(libs.spring.boot.starter.webflux)
    implementation(libs.reactor.kotlin.extensions)
    implementation(libs.kotlin.reflect)
    implementation(libs.kotlinx.coroutines.reactor)
    implementation(libs.jackson.module.kotlin)
    testImplementation(libs.spring.boot.starter.actuator.test)
    testImplementation(libs.spring.boot.starter.webflux.test)
    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        allWarningsAsErrors = true
        freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property")
    }
}

spotless {
    kotlin {
        target("src/**/*.kt")
        ktlint(libs.versions.ktlint.get())
    }
    kotlinGradle {
        target("*.gradle.kts")
        ktlint(libs.versions.ktlint.get())
    }
}

kover {
    reports {
        filters {
            excludes {
                classes("io.github.mrparkerz7.prskill.api.ApiApplicationKt")
            }
        }
        verify {
            rule("every line and every branch is covered") {
                bound {
                    minValue = 100
                    coverageUnits = CoverageUnit.LINE
                }
                bound {
                    minValue = 100
                    coverageUnits = CoverageUnit.BRANCH
                }
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // Without this input, a change to a contract fixture alone would be served from the build cache.
    inputs
        .files(rootProject.fileTree("contracts"))
        .withPropertyName("contracts")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.check {
    dependsOn("spotlessCheck", "koverVerify")
}
