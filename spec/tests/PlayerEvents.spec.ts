/// <reference path='../../src/ts/Conviva.d.ts'/>

import { MockHelper, TestingPlayerAPI } from '../helper/MockHelper';
import { ConvivaAnalytics } from '../../src/ts';

describe('player event tests', () => {
  let convivaAnalytics: ConvivaAnalytics;
  let playerMock: TestingPlayerAPI;
  let convivaVideoAnalytics: Conviva.ConvivaVideoAnalytics

  beforeEach(() => {
    MockHelper.mockConviva();

    playerMock = MockHelper.getPlayerMock();
    convivaVideoAnalytics = Conviva.Analytics.buildVideoAnalytics();

    convivaAnalytics = new ConvivaAnalytics(playerMock, 'TEST-KEY');
  });

  describe('player event handling', () => {
    describe('initialize session', () => {
      it('on play', () => {
        playerMock.eventEmitter.firePlayEvent();

        expect(convivaVideoAnalytics.reportPlaybackRequested).toHaveBeenCalledTimes(1);
      });

      it('on error', () => {
        playerMock.eventEmitter.fireErrorEvent();

        expect(convivaVideoAnalytics.reportPlaybackRequested).toHaveBeenCalledTimes(1);
      });
    });

    describe('update playback state', () => {
      beforeEach(() => {
        playerMock.eventEmitter.firePlayEvent();
      });

      it('on playing', () => {
        jest.spyOn(playerMock, 'isPaused').mockReturnValue(false);
        jest.spyOn(playerMock, 'isPlaying').mockReturnValue(true);
        playerMock.eventEmitter.firePlayingEvent();

        expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.PLAYING);
      });

      it('on pause', () => {
        jest.spyOn(playerMock, 'isPlaying').mockReturnValue(false);
        jest.spyOn(playerMock, 'isPaused').mockReturnValue(true);
        playerMock.eventEmitter.firePauseEvent();

        expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.PAUSED);
      });

    });
    it('should not crash here', () => {
      jest.spyOn(playerMock, 'isPaused').mockReturnValue(true);
      playerMock.eventEmitter.firePauseEvent();

      expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalled();
    });

    describe('v8 stalling handling', () => {
      // In v8 there is no stalling event between play / playing; seek / seeked; timeshift / thimeshifted but it
      // can be treated as stalling so we need to report it (maybe timeout in favor of seeking in buffer)

      describe('reports stalling', () => {
        describe('durring playback', () => {
          beforeEach(() => {
            playerMock.eventEmitter.firePlayEvent();
            playerMock.eventEmitter.firePlayingEvent();
          });


          it('right after stall started', () => {
            playerMock.eventEmitter.fireStallStartedEvent();
          });

          afterEach((done: any) => {
            setTimeout(function () {
              expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenLastCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
              done();
            }, 120);
          });
        });
      });

      describe('does not report stalling', () => {
        it('when content is preloaded', (done: any) => {
          playerMock.eventEmitter.firePlayEvent();
          setTimeout(() => {
            playerMock.eventEmitter.firePlayingEvent();

            expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
            setTimeout(() => {
              expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
              done();
            }, 2000);
          }, 30);
        });
      });

      describe('when buffer is ready', () => {
        beforeEach(() => {
          playerMock.eventEmitter.firePlayEvent();
          playerMock.eventEmitter.firePlayingEvent();
        });

        it('and seeking', (done: any) => {
          playerMock.eventEmitter.fireSeekEvent();
          setTimeout(() => {
            playerMock.eventEmitter.fireSeekedEvent();

            expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
            setTimeout(() => {
              expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
              done();
            }, 2000);
          }, 30);
        });

        it('and time shifting', (done: any) => {
          playerMock.eventEmitter.fireTimeShiftEvent();
          setTimeout(() => {
            playerMock.eventEmitter.fireTimeShiftedEvent();

            expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
            setTimeout(() => {
              expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalledWith(Conviva.Constants.Playback.PLAYER_STATE, Conviva.Constants.PlayerState.BUFFERING);
              done();
            }, 2000);
          }, 30);
        });
      });
    });

    describe('end session', () => {
      beforeEach(() => {
        playerMock.eventEmitter.firePlayEvent();
        playerMock.eventEmitter.firePlayingEvent();
      });
      it('on source unloaded', () => {
        playerMock.eventEmitter.fireSourceUnloadedEvent();

        expect(convivaVideoAnalytics.release).toHaveBeenCalledTimes(1);
      });

      it('on error', () => {
        playerMock.eventEmitter.fireErrorEvent();

        expect(convivaVideoAnalytics.release).toHaveBeenCalledTimes(1);
      });

      it('playback finished', () => {
        playerMock.eventEmitter.firePlaybackFinishedEvent();

        expect(convivaVideoAnalytics.release).toHaveBeenCalledTimes(1);
      });
    });

    describe('seeking', () => {
      beforeEach(() => {
        playerMock.eventEmitter.firePlayEvent();
        playerMock.eventEmitter.firePlayingEvent();
      });

      describe('track seek start', () => {
        it('on seek', () => {
          playerMock.eventEmitter.fireSeekEvent(50.145);
          expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.SEEK_STARTED);
        });

        it('on timeshift', () => {
          playerMock.eventEmitter.fireTimeShiftEvent();
          expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.SEEK_STARTED);
        });
      });

      describe('track seek end', () => {
        it('on seeked', () => {
          playerMock.eventEmitter.fireSeekedEvent();
          expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.SEEK_ENDED);
        });

        it('on timeshifted', () => {
          playerMock.eventEmitter.fireTimeShiftedEvent();
          expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.SEEK_ENDED);
        });
      });
    });
    it('does not track seek if play never happened', () => {
      playerMock.eventEmitter.fireSeekEvent();
      expect(convivaVideoAnalytics.reportPlaybackMetric).not.toHaveBeenCalled();
    });
  });

  describe('ad tracking', () => {
    beforeEach(() => {
      jest.spyOn(playerMock, 'getDuration').mockReturnValue(10);
      playerMock.eventEmitter.firePlayEvent();
      playerMock.eventEmitter.firePlayingEvent();
    });

    it('track pre-roll ad', () => {
      playerMock.eventEmitter.fireAdBreakStartedEvent(0);
      playerMock.eventEmitter.fireAdStartedEvent();
      expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledTimes(1);
      expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledWith(Conviva.Constants.AdType.CLIENT_SIDE, Conviva.Constants.AdPlayer.SEPARATE, Conviva.Constants.AdPosition.PREROLL);
    });

    it('track  mid-roll ad', () => {
      playerMock.eventEmitter.fireAdBreakStartedEvent(5);
      playerMock.eventEmitter.fireAdStartedEvent();
      expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledTimes(1);
      expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledWith(Conviva.Constants.AdType.CLIENT_SIDE, Conviva.Constants.AdPlayer.SEPARATE, Conviva.Constants.AdPosition.MIDROLL);
    });

    it('end session on post-roll ad', () => {
      playerMock.eventEmitter.fireAdBreakStartedEvent(Infinity);
      playerMock.eventEmitter.fireAdStartedEvent();
      expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledTimes(0);
      expect(convivaVideoAnalytics.release).toHaveBeenCalled();
    });

    describe('track ad end', () => {
      beforeEach(() => {
        playerMock.eventEmitter.fireAdBreakStartedEvent(0);
        playerMock.eventEmitter.fireAdStartedEvent();
      });

      it('on adError', () => {
        playerMock.eventEmitter.fireAdErrorEvent();
        playerMock.eventEmitter.fireAdBreakFinishedEvent();
        expect(convivaVideoAnalytics.reportAdBreakEnded).toHaveBeenCalledTimes(1);
      });

      it('on ad skipped', () => {
        playerMock.eventEmitter.fireAdSkippedEvent();
        playerMock.eventEmitter.fireAdBreakFinishedEvent();
        expect(convivaVideoAnalytics.reportAdBreakEnded).toHaveBeenCalledTimes(1);
      });

      it('on ad end', () => {
        playerMock.eventEmitter.fireAdBreakFinishedEvent();
        expect(convivaVideoAnalytics.reportAdBreakEnded).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('video quality tracking', () => {
    it('report bitrate on event', () => {
      playerMock.eventEmitter.firePlayEvent();
      playerMock.eventEmitter.firePlayingEvent();
      playerMock.eventEmitter.fireVideoPlaybackQualityChangedEvent(2_400_000, 30);

      expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.BITRATE, 2_400);
    });

    it('report framerate on event', () => {
      playerMock.eventEmitter.firePlayEvent();
      playerMock.eventEmitter.firePlayingEvent();
      playerMock.eventEmitter.fireVideoPlaybackQualityChangedEvent(2_400_000, 30);

      expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.RENDERED_FRAMERATE, 30);
    });

    describe('event order workaround', () => {
      it('track current bitrate on session initialization', () => {
        playerMock.eventEmitter.fireVideoPlaybackQualityChangedEvent(4_800_000, 30);
        playerMock.eventEmitter.firePlayEvent();
        playerMock.eventEmitter.firePlayingEvent();

        expect(convivaVideoAnalytics.reportPlaybackMetric).toHaveBeenCalledWith(Conviva.Constants.Playback.BITRATE, 4_800);
      });
    });
  });

  describe('ad event workarounds', () => {
    describe('event order in case of pre-roll ad', () => {
      it('track pre-roll ad', () => {
        playerMock.eventEmitter.fireAdBreakStartedEvent(0);
        playerMock.eventEmitter.firePlayEvent();
        playerMock.eventEmitter.firePlayingEvent();
        playerMock.eventEmitter.fireAdStartedEvent();

        expect(convivaVideoAnalytics.reportAdBreakStarted).toHaveBeenCalledTimes(1);
      });
    });
  });
});
