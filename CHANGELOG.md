# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]
### Added
- Tracking the current framerate

## [4.0.3]
### Added
- `bitmovin-player@^8.31.0` as peer dependency.
- Possibility to set detailed Conviva Device Metadata via `ConvivaAnalyticsConfiguration.deviceMetadata`
- Possibility to override values for internally set custom metdata keys `streamType`, `playerType` and `vrContentType`

### Deprecated
- `ConvivaAnalyticsConfiguration.deviceCategory` field in favour of `ConvivaAnalyticsConfiguration.deviceMetadata.category` field

## [4.0.2]

### Fixed
- Metadata was cleared after playback finished.

## [4.0.1]

### Fixed
- Uncaught TypeError (`Cannot read property 'release' of null`) when attempting to release the Conviva instance.

## [4.0.0]

### Added
- Support for Conviva-SDK 4.0.15.

### Removed
- Support for Conviva-SDK 2.151.0.36981.

## [3.0.6]

### Fixed
- Prefer `window.setInterval()` in `Html5Timer.ts` instead of the NodeJS definition.

## [3.0.5]

### Fixed
- Updated `webpack-dev-server` to the latest version, to resolve console errors when running locally via `npm run start`.

## [3.0.4]

### Fixed
- Send playing event after an ad break has finished.

## [3.0.3]

### Added
- Added a configuration option to set the Conviva Device Category. 

## [3.0.2]

### Added
- `endSession` will now prevent a new session from being initialized via internal event handling.

## [3.0.1]

### Added
- Support for Conviva-SDK 2.151.0.36981.

## [3.0.0]

### Added
- `initializeSession` to external start session.
- `endSession` to external end session.
- `updateContentMetadata` to update content metadata after initializing.`ConvivaAnalytics`
- Support for Player v8 events.

### Changed
- Update to Bitmovin Player v8 API.
- Switch to Webpack.
- Improve typings.

### Removed
- `viewerId`, `applicationName` and `customTags` from `ConvivaAnalyticsConfiguration`. Use `updateContentMetadata` instead.

## [2.0.0] (2018-12-12)

### Added
- Tracking of `autoplay` and `preload` config attributes.
- Live stream support.

### Changed
- Updated Conviva-SDK to 2.146.0.36444.
- Bind `PlayerStateManager`'s lifecycle to the lifecycle of the `Client`.

### Removed
- Seek event tracking

## [95c526]

Support for Conviva-SDK version below 2.146.0.36444

[4.0.2]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v4.0.2...v4.0.3
[4.0.2]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v4.0.1...v4.0.2
[4.0.1]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.6...v4.0.0
[3.0.6]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.5...v3.0.6
[3.0.5]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.4...v3.0.5
[3.0.4]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/compare/95c526a7306cef98061f8f65e3dec3023df501af...v3.0.0
[95c526]: https://github.com/bitmovin/bitmovin-player-analytics-conviva/commit/95c526a7306cef98061f8f65e3dec3023df501af
