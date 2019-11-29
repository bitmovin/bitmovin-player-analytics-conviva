import { AdExperienceTrackingPlugin } from './AdExperienceTrackingPlugin';

import {
  AdBreakEvent, AdEvent, CastStartedEvent, ErrorEvent, PlaybackEvent, PlayerAPI, PlayerEvent, PlayerEventBase,
  SeekEvent, SourceConfig, TimeShiftEvent, VideoQualityChangedEvent,
} from 'bitmovin-player';
import { Html5Http } from './Html5Http';
import { Html5Logging } from './Html5Logging';
import { Html5Metadata } from './Html5Metadata';
import { Html5Storage } from './Html5Storage';
import { Html5Time } from './Html5Time';
import { Html5Timer } from './Html5Timer';
import { Timeout } from 'bitmovin-player-ui/dist/js/framework/timeout';
import { ContentMetadataBuilder, Metadata } from './ContentMetadataBuilder';
import { AdBreakTrackingPlugin } from './AdBreakTrackingPlugin';
import { ObjectUtils } from './helper/ObjectUtils';
import { AdTrackingPlugin } from './AdTrackingPlugin';
import { AdBreakHelper } from './helper/AdBreakHelper';
import { BrowserUtils } from './helper/BrowserUtils';
import { BasicAdTrackingPlugin } from './BasicAdTrackingPlugin';
import { BitrateHelper } from './helper/BitrateHelper';

import { ArrayUtils } from 'bitmovin-player-ui/dist/js/framework/arrayutils';

type Player = PlayerAPI;

export enum AdTrackingMode {
  Basic = 'Basic',
  AdBreaks = 'AdBreaks',
  AdExperience = 'AdExperience', // AdInsights includes AdBreaks + AdExperience
}

export interface ConvivaAnalyticsConfiguration {
  /**
   * Enables debug logging when set to true (default: false).
   */
  debugLoggingEnabled?: boolean;
  /**
   * The TOUCHSTONE_SERVICE_URL for testing with Touchstone. Only to be used for development, must not be set in
   * production or automated testing.
   */
  gatewayUrl?: string;

  /**
   * Switch between different adTrackingModes.
   *
   * Available modes:
   * - Basic: (Default)
   * Stops all tracking to the content session during adBreaks.
   * - AdBreaks:
   * Reports more details about the adBreak to the current session. (Also includes behaviour of Basic mode)
   * - AdExperience:
   * Creates a new ad session for each ad and track ad related events to the ad session.
   * (Also includes behaviour of AdBreaks mode).
   */
  adTrackingMode?: AdTrackingMode;
}

export interface EventAttributes {
  [key: string]: string;
}

export class ConvivaAnalytics {

  private static readonly VERSION: string = '{{VERSION}}';

  private static STALL_TRACKING_DELAY_MS = 100;
  private static CAST_METADATA_TYPE = 'updateContentMetadata';
  private readonly player: Player;
  private events: typeof PlayerEvent;
  private readonly handlers: PlayerEventWrapper;
  private config: ConvivaAnalyticsConfiguration;
  private readonly contentMetadataBuilder: ContentMetadataBuilder;

  private readonly systemFactory: Conviva.SystemFactory;
  private readonly client: Conviva.Client;
  private playerStateManager: Conviva.PlayerStateManager;

  private readonly logger: Conviva.LoggingInterface;
  private sessionKey: number;

  private adTrackingPlugin: AdTrackingPlugin;

  /**
   * Attributes needed to workaround wrong event order in case of a pre-roll ad.
   * See {@link onAdBreakStarted} for more info
   */
  private adBreakStartedToFire: AdBreakEvent;

  /**
   * Needed to workaround wrong event order in case of a video-playback-quality-change event.
   * See {@link onVideoQualityChanged} for more info
   */
  private lastSeenBitrate: number;

  // Since there are no stall events during play / playing; seek / seeked; timeShift / timeShifted we need
  // to track stalling state between those events. To prevent tracking eg. when seeking in buffer we delay it.
  private stallTrackingTimout: Timeout = new Timeout(ConvivaAnalytics.STALL_TRACKING_DELAY_MS, () => {
    this.playerStateManager.setPlayerState(Conviva.PlayerStateManager.PlayerState.BUFFERING);
  });
  private isAdPlaybackActive: boolean;

  /**
   * Boolean to track whether a session was ended by an upstream caller instead of within internal session management.
   * If this is true, we should avoid initializing a new session internally if a session is not active
   */
  private sessionEndedExternally = false;

  constructor(player: Player, customerKey: string, config: ConvivaAnalyticsConfiguration = {}) {
    if (typeof Conviva === 'undefined') {
      console.error('Conviva script missing, cannot init ConvivaAnalytics. '
        + 'Please load the Conviva script (conviva-core-sdk.min.js) before Bitmovin\'s ConvivaAnalytics integration.');
      return; // Cancel initialization
    }

    if (player.getSource()) {
      console.error('Bitmovin Conviva integration must be instantiated before calling player.load()');
      return; // Cancel initialization
    }

    this.player = player;

    // TODO: Use alternative to deprecated player.exports
    this.events = player.exports.PlayerEvent;

    this.handlers = new PlayerEventWrapper(player);
    this.config = config;

    // Set default config values
    this.config.debugLoggingEnabled = this.config.debugLoggingEnabled || false;

    this.logger = new Html5Logging();
    this.sessionKey = Conviva.Client.NO_SESSION_KEY;

    const systemInterface = new Conviva.SystemInterface(
      new Html5Time(),
      new Html5Timer(),
      new Html5Http(),
      new Html5Storage(),
      new Html5Metadata(),
      this.logger,
    );

    const systemSettings = new Conviva.SystemSettings();
    this.systemFactory = new Conviva.SystemFactory(systemInterface, systemSettings);

    const clientSettings = new Conviva.ClientSettings(customerKey);

    if (config.gatewayUrl) {
      clientSettings.gatewayUrl = config.gatewayUrl;
    }

    this.client = new Conviva.Client(clientSettings, this.systemFactory);
    this.contentMetadataBuilder = new ContentMetadataBuilder(this.logger);

    this.registerPlayerEvents();
  }

  /**
   * Initializes a new conviva tracking session.
   *
   * Warning: The integration can only be validated without external session managing. So when using this method we can
   * no longer ensure that the session is managed at the correct time. Additional: Since some metadata attributes
   * relies on the players source we can't ensure that all metadata attributes are present at session creation.
   * Therefore it could be that there will be a 'ContentMetadata created late' issue after conviva validation.
   *
   * If no source was loaded and no assetName was set via updateContentMetadata this method will throw an error.
   */
  public initializeSession(): void {
    if (this.isSessionActive()) {
      this.logger.consoleLog('There is already a session running.', Conviva.SystemSettings.LogLevel.WARNING);
      return;
    }

    // This could be called before source loaded.
    // Without setting the asset name on the content metadata the SDK will throw errors when we initialize the session.
    if (!this.player.getSource() && !this.contentMetadataBuilder.assetName) {
      throw('AssetName is missing. Load player source first or set assetName via updateContentMetadata');
    }

    this.internalInitializeSession();
    this.sessionEndedExternally = false;
  }

  /**
   * Ends the current conviva tracking session.
   * Results in a no-opt if there is no active session.
   *
   * Warning: Sessions will no longer be created automatically after this method has been called.
   *
   * The integration can only be validated without external session managing. So when using this method we can
   * no longer ensure that the session is managed at the correct time.
   */
  public endSession(): void {
    if (!this.isSessionActive()) {
      return;
    }

    this.internalEndSession();
    this.resetContentMetadata();
    this.sessionEndedExternally = true;
  }

  /**
   * Sends a custom application-level event to Conviva's Player Insight. An application-level event can always
   * be sent and is not tied to a specific video.
   * @param eventName arbitrary event name
   * @param eventAttributes a string-to-string dictionary object with arbitrary attribute keys and values
   */
  public sendCustomApplicationEvent(eventName: string, eventAttributes: EventAttributes = {}): void {
    this.client.sendCustomEvent(Conviva.Client.NO_SESSION_KEY, eventName, eventAttributes);
  }

  /**
   * Sends a custom playback-level event to Conviva's Player Insight. A playback-level event can only be sent
   * during an active video session.
   * @param eventName arbitrary event name
   * @param eventAttributes a string-to-string dictionary object with arbitrary attribute keys and values
   */
  public sendCustomPlaybackEvent(eventName: string, eventAttributes: EventAttributes = {}): void {
    // Check for active session
    if (!this.isSessionActive()) {
      this.logger.consoleLog('cannot send playback event, no active monitoring session',
        Conviva.SystemSettings.LogLevel.WARNING);
      return;
    }

    this.client.sendCustomEvent(this.sessionKey, eventName, eventAttributes);
  }

  /**
   * Will update the contentMetadata which are tracked with conviva.
   *
   * If there is an active session only permitted values will be updated and propagated immediately.
   * If there is no active session the values will set on session creation.
   *
   * Attributes set via this method will override automatic tracked once.
   * @param metadataOverrides Metadata attributes which will be used to track to conviva.
   * @see ContentMetadataBuilder for more information about permitted attributes
   */
  public updateContentMetadata(metadataOverrides: Metadata) {
    if (this.player.isCasting()) {
      this.propagateOverridesToReceiver(metadataOverrides);
    }

    this.internalUpdateContentMetadata(metadataOverrides);
  }

  /**
   * Sends a custom deficiency event during playback to Conviva's Player Insight. If no session is active it will NOT
   * create one.
   *
   * @param message Message which will be send to conviva
   * @param severity One of FATAL or WARNING
   * @param endSession Boolean flag if session should be closed after reporting the deficiency (Default: true)
   */
  public reportPlaybackDeficiency(message: string, severity: Conviva.Client.ErrorSeverity, endSession: boolean = true) {
    if (!this.isSessionActive()) {
      return;
    }

    this.client.reportError(this.sessionKey, message, severity);
    if (endSession) {
      this.internalEndSession();
      this.resetContentMetadata();
    }
  }

  /**
   * Puts the session state in a notMonitored state.
   */
  public pauseTracking(): void {
    // AdStart is the right way to pause monitoring according to conviva.
    this.client.adStart(
      this.sessionKey,
      Conviva.Client.AdStream.SEPARATE,
      Conviva.Client.AdPlayer.SEPARATE,
      Conviva.Client.AdPosition.PREROLL, // Also stops tracking time for VST so PREROLL seems to be sufficient
    );
    this.client.detachPlayer(this.sessionKey);
    this.debugLog('Tracking paused.');
  }

  /**
   * Puts the session state from a notMonitored state into the last one tracked.
   */
  public resumeTracking(): void {
    // AdEnd is the right way to resume monitoring according to conviva.
    this.client.attachPlayer(this.sessionKey, this.playerStateManager);
    this.client.adEnd(this.sessionKey);
    this.debugLog('Tracking resumed.');
  }

  /**
   * Use this method if you are using the conviva integration on a custom receiver app.
   *
   * See README.md for more information on how to use
   * @param metadata
   */
  public handleCastMetadataEvent(metadata: any): void {
    if (metadata.type === ConvivaAnalytics.CAST_METADATA_TYPE) {
      this.internalUpdateContentMetadata(metadata.metadata);
    }
  }

  public release(): void {
    this.destroy();
  }

  private destroy(event?: PlayerEventBase): void {
    this.unregisterPlayerEvents();
    this.internalEndSession(event);
    this.client.release();
    this.systemFactory.release();
  }

  private debugLog(message?: any, ...optionalParams: any[]): void {
    if (this.config.debugLoggingEnabled) {
      console.log.apply(console, arguments);
    }
  }

  private getUrlFromSource(source: SourceConfig): string {
    switch (this.player.getStreamType()) {
      case 'dash':
        return source.dash;
      case 'hls':
        return source.hls;
      case 'progressive':
        if (Array.isArray(source.progressive)) {
          // TODO check if the first stream can be another index (e.g. ordered by bitrate), and select the current
          // startup url
          return source.progressive[0].url;
        } else {
          return source.progressive;
        }
    }
  }

  private internalUpdateContentMetadata(metadataOverrides: Metadata) {
    this.contentMetadataBuilder.setOverrides(metadataOverrides);

    if (!this.isSessionActive()) {
      this.logger.consoleLog(
        '[ ConvivaAnalytics ] no active session. Content metadata will be propagated to Conviva on session initialization.',
        Conviva.SystemSettings.LogLevel.DEBUG,
      );
      return;
    }

    this.buildContentMetadata();
    this.updateSession();
  }

  /**
   * A Conviva Session should only be initialized when there is a source provided in the player because
   * Conviva only allows to update different `contentMetadata` only at different times.
   *
   * The session should be created as soon as there was a play intention from the user.
   *
   * Set only once:
   *  - assetName
   *
   * Update before first video frame:
   *  - viewerId
   *  - streamType
   *  - playerName
   *  - duration
   *  - custom
   *
   * Multiple updates during session:
   *  - streamUrl
   *  - defaultResource (unused)
   *  - encodedFrameRate (unused)
   */
  private internalInitializeSession() {
    // initialize PlayerStateManager
    this.playerStateManager = this.client.getPlayerStateManager();
    this.playerStateManager.setPlayerType('Bitmovin Player');
    this.playerStateManager.setPlayerVersion(this.player.version);

    this.buildContentMetadata();

    // Create a Conviva monitoring session.
    this.sessionKey = this.client.createSession(this.contentMetadataBuilder.build()); // this will make the initial request

    // Init ad tracking with current session key
    switch (this.config.adTrackingMode) {
      case AdTrackingMode.AdExperience:
        this.adTrackingPlugin = new AdExperienceTrackingPlugin(this.player, this.client, this.sessionKey, this.logger);
        break;
      case AdTrackingMode.AdBreaks:
        this.adTrackingPlugin = new AdBreakTrackingPlugin(this.player, this.client, this.sessionKey, this.logger);
        break;
      default:
        this.adTrackingPlugin = new BasicAdTrackingPlugin(this.player, this.client, this.sessionKey, this.logger);
        break;
    }

    this.debugLog('[ ConvivaAnalytics ] start session', this.sessionKey);

    if (!this.isSessionActive()) {
      // Something went wrong. With stable system interfaces, this should never happen.
      this.logger.consoleLog('Something went wrong, could not obtain session key',
        Conviva.SystemSettings.LogLevel.ERROR);
    }

    this.playerStateManager.setPlayerState(Conviva.PlayerStateManager.PlayerState.STOPPED);
    this.client.attachPlayer(this.sessionKey, this.playerStateManager);

    if (this.lastSeenBitrate) {
      this.debugLog('### [ ConvivaAnalytics ] internalInitializeSession, set setBitrateKbps: ', this.lastSeenBitrate);
      this.playerStateManager.setBitrateKbps(this.lastSeenBitrate);
    }
  }

  /**
   * Update contentMetadata which must be present before first video frame
   */
  private buildContentMetadata() {
    this.contentMetadataBuilder.duration = this.player.getDuration();
    this.contentMetadataBuilder.streamType = this.player.isLive() ? Conviva.ContentMetadata.StreamType.LIVE : Conviva.ContentMetadata.StreamType.VOD;

    this.contentMetadataBuilder.custom = {
      // Autoplay and preload are important options for the Video Startup Time so we track it as custom tags
      autoplay: PlayerConfigHelper.getAutoplayConfig(this.player) + '',
      preload: PlayerConfigHelper.getPreloadConfig(this.player) + '',
      integrationVersion: ConvivaAnalytics.VERSION,
    };

    const source = this.player.getSource();

    // This could be called before we got a source
    if (source) {
      this.buildSourceRelatedMetadata(source);
    }
  }

  private buildSourceRelatedMetadata(source: SourceConfig) {
    this.contentMetadataBuilder.assetName = this.getAssetNameFromSource(source);
    this.contentMetadataBuilder.viewerId = this.contentMetadataBuilder.viewerId;
    this.contentMetadataBuilder.custom = {
      ...this.contentMetadataBuilder.custom,
      playerType: this.player.getPlayerType(),
      streamType: this.player.getStreamType(),
      vrContentType: source.vr && source.vr.contentType,
    };

    this.contentMetadataBuilder.streamUrl = this.getUrlFromSource(source);
  }

  private updateSession() {
    if (!this.isSessionActive()) {
      return;
    }

    this.client.updateContentMetadata(this.sessionKey, this.contentMetadataBuilder.build());
  }

  // This will propagate content metadata overrides to the conviva instance of the receiver app
  private propagateOverridesToReceiver(metadataOverrides?: Metadata) {
    metadataOverrides = metadataOverrides || this.contentMetadataBuilder.getOverrides();

    const metadataObject = {
      type: ConvivaAnalytics.CAST_METADATA_TYPE,
      metadata: metadataOverrides,
    };

    // The PlayerExports type does not contain the MetadataType but it is actually there so we need the as any cast.
    const metadataType = (this.player.exports as any).MetadataType.CAST;
    this.player.addMetadata(metadataType, metadataObject);
  }

  private getAssetNameFromSource(source: SourceConfig): string {
    let assetName;

    const assetTitle = source.title;
    if (assetTitle) {
      assetName = assetTitle;
    } else {
      assetName = 'Untitled (no source.title set)';
    }

    return assetName;
  }

  private internalEndSession = (event?: PlayerEventBase) => {
    if (!this.isSessionActive()) {
      return;
    }

    this.debugLog('[ ConvivaAnalytics ] end session', this.sessionKey, event);
    this.client.detachPlayer(this.sessionKey);
    this.client.cleanupSession(this.sessionKey);
    this.client.releasePlayerStateManager(this.playerStateManager);

    this.sessionKey = Conviva.Client.NO_SESSION_KEY;
    // this.lastSeenBitrate = null;
    // this.debugLog('### [ ConvivaAnalytics ] end session with last bitrate: ', this.lastSeenBitrate);

    // As the session could be continued after casting we can't reset the contentMetadataBuilder here as we would lose
    // content metadata attributes.
  };

  // Do not reset if the session gets closed due to casting. Only reset content metadata on:
  // - PlaybackFinished
  // - SourceUnloaded
  // - Error
  private resetContentMetadata(): void {
    this.contentMetadataBuilder.reset();
  }

  private isSessionActive(): boolean {
    return this.sessionKey !== Conviva.Client.NO_SESSION_KEY;
  }

  private onPlaybackStateChanged = (event: PlayerEventBase) => {
    let playerState;

    switch (event.type) {
      case this.events.Play:
      case this.events.Seek:
      case this.events.TimeShift:
        this.stallTrackingTimout.start();
        break;
      case this.events.StallStarted:
        this.stallTrackingTimout.clear();
        playerState = Conviva.PlayerStateManager.PlayerState.BUFFERING;
        break;
      case this.events.Playing:
        this.stallTrackingTimout.clear();

        // In case of a pre-roll ad we need to fire the trackAdBreakStarted right after we got a onPlay
        // See onAdBreakStarted for more details.
        if (this.adBreakStartedToFire) {
          this.trackAdBreakStarted(this.adBreakStartedToFire);
          this.adBreakStartedToFire = null;
        }

        playerState = Conviva.PlayerStateManager.PlayerState.PLAYING;
        break;
      case this.events.Paused:
        this.stallTrackingTimout.clear();
        playerState = Conviva.PlayerStateManager.PlayerState.PAUSED;
        break;
      case this.events.Seeked:
      case this.events.TimeShifted:
      case this.events.StallEnded:
        this.stallTrackingTimout.clear();
        if (this.player.isPlaying()) {
          playerState = Conviva.PlayerStateManager.PlayerState.PLAYING;
        } else {
          playerState = Conviva.PlayerStateManager.PlayerState.PAUSED;
        }
        break;
      case this.events.PlaybackFinished:
        this.stallTrackingTimout.clear();
        playerState = Conviva.PlayerStateManager.PlayerState.STOPPED;
        break;
    }

    if (playerState) {
      this.debugLog('[ ConvivaAnalytics ] report playback state', playerState);
      if (this.adTrackingPlugin && this.adTrackingPlugin.isAdSessionActive()) {
        this.adTrackingPlugin.reportPlayerState(playerState);
      } else if (this.isSessionActive()) {
        this.playerStateManager.setPlayerState(playerState);
      }
    }
  };

  private onSourceLoaded = (event: PlayerEventBase) => {
    // In case the session was created external before loading the source
    if (!this.isSessionActive()) {
      return;
    }

    this.buildSourceRelatedMetadata(this.player.getSource());
    this.updateSession();
  };

  private onPlay = (event: PlaybackEvent) => {
    this.debugLog('[ Player Event ] play', event);

    // in case the playback has finished and the user replays the stream create a new session
    if (!this.isSessionActive() && !this.sessionEndedExternally) {
      this.internalInitializeSession();
    }

    this.onPlaybackStateChanged(event);
  };

  private onPlaying = (event: PlaybackEvent) => {
    this.contentMetadataBuilder.setPlaybackStarted(true);
    this.debugLog('[ Player Event ] playing', event);
    this.updateSession();
    this.onPlaybackStateChanged(event);
  };

  private onPlaybackFinished = (event: PlayerEventBase) => {
    this.debugLog('[ Player Event ] playback finished', event);

    if (!this.isSessionActive()) {
      return;
    }

    this.onPlaybackStateChanged(event);
    this.internalEndSession(event);
    this.resetContentMetadata();
  };

  private onVideoQualityChanged = (event: VideoQualityChangedEvent) => {
    const bitrateKbps = BitrateHelper.calculateKbps(event.targetQuality.bitrate);

    if (!this.isSessionActive()) {
      // Since the first videoPlaybackQualityChanged event comes before playback ever started we need to store the
      // value and use it for tracking when initializing the session.
      // TODO: remove this workaround when the player event order is fixed
      this.lastSeenBitrate = bitrateKbps;
      // this.debugLog('### [ ConvivaAnalytics ] onVideoQualityChanged, !isSessionActive, set last bitrate: ', this.lastSeenBitrate);
      return;
    }
    this.lastSeenBitrate = bitrateKbps;
    // this.lastSeenBitrate = null;
    // this.debugLog('### [ ConvivaAnalytics ] onVideoQualityChanged, set last bitrate to NULL: ', this.lastSeenBitrate);
    this.playerStateManager.setBitrateKbps(bitrateKbps);
    this.debugLog('### [ ConvivaAnalytics ] onVideoQualityChanged, set setBitrateKbps: ',  bitrateKbps);
  };

  private onCustomEvent = (event: PlayerEventBase) => {
    if (!this.isSessionActive()) {
      this.debugLog('skip custom event, no session existing', event);
      return;
    }

    const eventAttributes = ObjectUtils.flatten(event);
    if (this.adTrackingPlugin.isAdSessionActive()) {
      this.adTrackingPlugin.reportCustomEvent(event.type, eventAttributes);
    } else {
      this.sendCustomPlaybackEvent(event.type, eventAttributes);
    }
  };

  private trackAdBreakStarted = (event: AdBreakEvent) => {
    this.debugLog('[ ConvivaAnalytics ] adbreak started', event);

    const adPosition = AdBreakHelper.mapAdPosition(event.adBreak, this.player);

    if (!this.isSessionActive()) {
      // Don't report without a valid session (e.g., in case of a pre-roll, or post-roll ad)
      return;
    }

    this.adTrackingPlugin.adBreakStarted(event.adBreak, adPosition);
  };

  private onAdBreakFinished = (event: AdBreakEvent | ErrorEvent) => {
    this.debugLog('[ ConvivaAnalytics ] adbreak finished', event);

    if (!this.isSessionActive()) {
      // Don't report without a valid session (e.g., in case of a pre-roll, or post-roll ad)
      return;
    }

    this.adTrackingPlugin.adBreakFinished();
  };

  private onSeek = (event: SeekEvent) => {
    if (!this.isSessionActive()) {
      // Handle the case that the User seeks on the UI before play was triggered.
      // This also handles startTime feature. The same applies for onTimeShift.
      return;
    }

    this.trackSeekStart(event.seekTarget);
    this.onPlaybackStateChanged(event);
  };

  private onSeeked = (event: SeekEvent) => {
    if (!this.isSessionActive()) {
      // See comment in onSeek
      return;
    }

    this.trackSeekEnd();
    this.onPlaybackStateChanged(event);
  };

  private onTimeShift = (event: TimeShiftEvent) => {
    if (!this.isSessionActive()) {
      // See comment in onSeek
      return;
    }

    // According to conviva it is valid to pass -1 for seeking in live streams
    this.trackSeekStart(-1);
    this.onPlaybackStateChanged(event);
  };

  private onTimeShifted = (event: TimeShiftEvent) => {
    if (!this.isSessionActive()) {
      // See comment in onSeek
      return;
    }

    this.trackSeekEnd();
    this.onPlaybackStateChanged(event);
  };

  private trackSeekStart(target: number) {
    this.playerStateManager.setPlayerSeekStart(Math.round(target));
  }

  private trackSeekEnd() {
    this.playerStateManager.setPlayerSeekEnd();
  }

  private onError = (event: ErrorEvent) => {
    if (!this.isSessionActive() && !this.sessionEndedExternally) {
      // initialize Session if not yet initialized to capture Video Start Failures
      this.internalInitializeSession();
    }

    this.reportPlaybackDeficiency(String(event.code) + ' ' + event.name, Conviva.Client.ErrorSeverity.FATAL);
  };

  private onSourceUnloaded = (event: PlayerEventBase) => {
    if (this.adTrackingPlugin.isAdSessionActive()) {
      this.adTrackingPlugin.adFinished();
    } else {
      this.internalEndSession(event);
      this.resetContentMetadata();
    }
  };

  private onDestroy = (event: any) => {
    this.destroy(event);
  };

  private registerPlayerEvents(): void {
    const playerEvents = this.handlers;

    playerEvents.add(this.events.SourceLoaded, this.onSourceLoaded);
    playerEvents.add(this.events.Play, this.onPlay);
    playerEvents.add(this.events.Playing, this.onPlaying);
    playerEvents.add(this.events.Paused, this.onPlaybackStateChanged);
    playerEvents.add(this.events.StallStarted, this.onPlaybackStateChanged);
    playerEvents.add(this.events.StallEnded, this.onPlaybackStateChanged);
    playerEvents.add(this.events.PlaybackFinished, this.onPlaybackFinished);
    playerEvents.add(this.events.VideoPlaybackQualityChanged, this.onVideoQualityChanged);
    playerEvents.add(this.events.AudioPlaybackQualityChanged, this.onCustomEvent);
    playerEvents.add(this.events.Muted, this.onCustomEvent);
    playerEvents.add(this.events.Unmuted, this.onCustomEvent);
    playerEvents.add(this.events.ViewModeChanged, this.onCustomEvent);
    playerEvents.add(this.events.AdBreakStarted, this.onAdBreakStarted);
    playerEvents.add(this.events.AdBreakFinished, this.onAdBreakFinished);
    playerEvents.add(this.events.AdSkipped, this.onAdSkipped);
    playerEvents.add(this.events.AdClicked, this.onCustomEvent);
    playerEvents.add(this.events.AdError, this.onAdError);
    playerEvents.add(this.events.SourceUnloaded, this.onSourceUnloaded);
    playerEvents.add(this.events.Error, this.onError);
    playerEvents.add(this.events.Destroy, this.onDestroy);
    playerEvents.add(this.events.Seek, this.onSeek);
    playerEvents.add(this.events.Seeked, this.onSeeked);
    playerEvents.add(this.events.TimeShift, this.onTimeShift);
    playerEvents.add(this.events.TimeShifted, this.onTimeShifted);

    // Ad tracking events
    playerEvents.add(this.events.AdStarted, this.onAdStarted);
    playerEvents.add(this.events.AdFinished, this.onAdFinished);

    // We need to wait until the user chose a device for closing the session on the sender app
    playerEvents.add(this.events.CastWaitingForDevice, this.onCastInitiated);
    playerEvents.add(this.events.CastStarted, this.onCastStarted);
    playerEvents.add(this.events.CastStopped, this.onCastStopped);
  }

  private onCastStarted = () => {
    this.propagateOverridesToReceiver();
  };

  private onAdStarted = (event: AdEvent) => {
    this.adTrackingPlugin.adStarted(event);
  };

  private onAdFinished = (event: AdEvent) => {
    this.adTrackingPlugin.adFinished();
  };

  private onAdBreakStarted = (event: AdBreakEvent) => {
    // Specific pre-roll handling
    // TODO: remove this workaround when event order is correct
    // Since the event order on initial playback in case of a pre-roll ad is false we need to workaround
    // a to early triggered adBreakStarted event. The initial onPlay event is called after the AdBreakStarted
    // of the pre-roll ad so we won't initialize a session. Therefore we save the adBreakStarted event and
    // trigger it in the initial onPlay event (after initializing the session). (See #onPlaybackStateChanged)
    if (!this.isSessionActive()) {
      this.adBreakStartedToFire = event;
    } else {
      this.trackAdBreakStarted(event);
    }
  };

  private onAdSkipped = (event: AdEvent) => {
    this.onCustomEvent(event);
    // Track adFinished after skipping
    this.onAdFinished(event);
  };

  private onAdError = (event: AdEvent) => {
    this.onCustomEvent(event);
    // Track adFinished after error
    this.onAdFinished(event);
  };

  private onCastInitiated = (event: CastStartedEvent) => {
    this.onCustomEvent(event);
    this.internalEndSession(event);

    // We don't want to receive events from the receiver as they could screw up the session handling on the sender App,
    // so we unsubscribe from all events except from the CastStopped.
    this.unregisterPlayerEvents();
    this.handlers.add(this.events.CastStopped, this.onCastStopped);
  };

  private onCastStopped = () => {
    // After casting we want all events again so subscribe again to all.
    this.unregisterPlayerEvents();
    this.registerPlayerEvents();

    if (this.player.isPlaying() && !this.isSessionActive() && !this.sessionEndedExternally) {
      this.internalInitializeSession();
      this.playerStateManager.setPlayerState(Conviva.PlayerStateManager.PlayerState.PLAYING);
    }
  };

  private unregisterPlayerEvents(): void {
    this.handlers.clear();
  }

  static get version(): string {
    return ConvivaAnalytics.VERSION;
  }
}

class PlayerConfigHelper {
  /**
   * The config for autoplay and preload have great impact to the VST (Video Startup Time) we track it.
   * Since there is no way to get default config values from the player they are hardcoded.
   */
  public static AUTOPLAY_DEFAULT_CONFIG: boolean = false;

  /**
   * Extract autoplay config form player
   *
   * @param player: Player
   */
  public static getAutoplayConfig(player: Player): boolean {
    const playerConfig = player.getConfig();

    if (playerConfig.playback && playerConfig.playback.autoplay !== undefined) {
      return playerConfig.playback.autoplay;
    } else {
      return PlayerConfigHelper.AUTOPLAY_DEFAULT_CONFIG;
    }
  }

  /**
   * Extract preload config from player
   *
   * The preload config can be set individual for mobile or desktop as well as on root level for both platforms.
   * Default value is true for VOD and false for live streams. If the value is not set for current platform or on root
   * level the default value will be used over the value for the other platform.
   *
   * @param player: Player
   */
  public static getPreloadConfig(player: Player): boolean {
    const playerConfig = player.getConfig();

    if (BrowserUtils.isMobile()) {
      if (playerConfig.adaptation
        && playerConfig.adaptation.mobile
        && playerConfig.adaptation.mobile.preload !== undefined) {
        return playerConfig.adaptation.mobile.preload;
      }
    } else {
      if (playerConfig.adaptation
        && playerConfig.adaptation.desktop
        && playerConfig.adaptation.desktop.preload !== undefined) {
        return playerConfig.adaptation.desktop.preload;
      }
    }

    if (playerConfig.adaptation
      && playerConfig.adaptation.preload !== undefined) {
      return playerConfig.adaptation.preload;
    }

    return !player.isLive();
  }
}

class PlayerEventWrapper {

  private player: Player;
  private readonly eventHandlers: { [eventType: string]: Array<(event?: PlayerEventBase) => void>; };

  constructor(player: Player) {
    this.player = player;
    this.eventHandlers = {};
  }

  public add(eventType: PlayerEvent, callback: (event?: PlayerEventBase) => void): void {
    this.player.on(eventType, callback);

    if (!this.eventHandlers[eventType]) {
      this.eventHandlers[eventType] = [];
    }

    this.eventHandlers[eventType].push(callback);
  }

  public remove(eventType: PlayerEvent, callback: (event?: PlayerEventBase) => void): void {
    this.player.off(eventType, callback);

    if (this.eventHandlers[eventType]) {
      ArrayUtils.remove(this.eventHandlers[eventType], callback);
    }
  }

  public clear(): void {
    for (const eventType in this.eventHandlers) {
      for (const callback of this.eventHandlers[eventType]) {
        this.remove(eventType as PlayerEvent, callback);
      }
    }
  }
}
