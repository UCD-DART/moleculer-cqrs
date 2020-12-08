/* eslint-disable global-require */
const {
  Errors: { MoleculerClientError, MoleculerServerError },
} = require("moleculer");
const createCommandHandler = require("resolve-command").default;
const createEsStorage = require("resolve-eventstore-lite").default;
// const createSnapshotAdapter = require("resolve-snapshot-lite").default;
const Validator = require("fastest-validator");

const aggregateSchema = {
  name: { type: "string", min: 3 },
  projection: {
    type: "object",
    props: { Init: "function" },
  },
  commands: { type: "object" },
  events: { type: "object" },
  // invariantHash: string?,
  // serializeState: function
  // deserializeState: function
};

module.exports = function CQRSEventSourcing({
  aggregate = false,
  replay = false,
}) {
  const v = new Validator();
  let vRes;

  if (aggregate) {
    // eslint-disable-next-line no-cond-assign
    if ((vRes = v.validate(aggregate, aggregateSchema)) !== true) {
      throw new Error(
        `CQRSEventSourcing${vRes.map((err) => err.message).join("\n")}`
      );
    }
  }

  return {
    commandHandler: undefined,
    aggregateName: undefined,
    eventstoreAdapter: undefined,
    onCommandExecuted: undefined,
    aggregate: undefined,
    metadata: {
      aggregate: false,
      commands: [],
      projection: [],
      events: [],
    },
    settings: {
      aggregate,
      replay,
    },
    actions: {
      command: {
        params: {
          aggregateId: "any",
          type: "string",
          payload: "object",
        },
        async handler(ctx) {
          const { aggregateId, type, payload } = ctx.params;
          try {
            if (this.aggregate === undefined) {
              throw new MoleculerClientError(
                `Command action is disabled '${this.name}', no aggregate configured!`
              );
            }
            this.logger.debug(
              `AggregateName: ${this.aggregateName} → ${aggregateId} → ${ctx.params.type}`
            );

            await this.commandHandler({
              aggregateId,
              aggregateName: this.aggregateName,
              type,
              payload,
            });
          } catch (e) {
            this.logger.error(e.message, ctx.params);
            this.logger.error(e);
            throw new MoleculerClientError(
              `Aggregate command (id:${aggregateId}) '${this.aggregateName}.${type}' failed: ${e.message}`
            );
          }
          return {
            status: true,
            aggregateName: this.aggregateName,
            aggregateId,
          };
        },
      },

      "read-model": {
        params: {
          aggregateId: "any",
          finishTime: { type: "number", integer: true, optional: true },
          limit: {
            type: "number",
            integer: true,
            optional: true,
            default: Number.MAX_SAFE_INTEGER,
          },
        },
        async handler(ctx) {
          if (!this.aggregate) {
            return "Aggregate is not configurated, read-model action is disabled!";
          }
          const hrstart = process.hrtime();
          const { aggregateId, finishTime, limit } = ctx.params;

          this.logger.info(aggregateId, ctx.params);

          this.logger.info(
            `Load event history for aggregate '${this.aggregateName}' with aggregateId '${aggregateId}', finishTime ${finishTime}, limit ${limit}`
          );

          const eventFilter = this.cleanFilter({
            aggregateIds: [aggregateId],
            finishTime,
            limit,
          });

          const result = await this.materializeReadModelState(eventFilter);

          const hrend = process.hrtime(hrstart);
          this.logger.info(
            `Materialized ${
              this.aggregateName
            } with aggregateId ${aggregateId} ${hrend[0]}s ${
              hrend[1] / 1000000
            }ms`
          );
          return result;
        },
      },

      history: {
        params: {
          aggregateId: "any",
          payload: { type: "any", optional: true },
          startTime: { type: "number", integer: true, optional: true },
          finishTime: { type: "number", integer: true, optional: true },
          limit: {
            type: "number",
            integer: true,
            optional: true,
            default: Number.MAX_SAFE_INTEGER,
          },
        },
        async handler(ctx) {
          if (!this.aggregate) {
            return "Aggregate is not configurated, history action is disabled!";
          }
          const hrstart = process.hrtime();
          const {
            aggregateId,
            payload = false,
            startTime,
            finishTime,
            limit,
          } = ctx.params;

          this.logger.info(aggregateId, ctx.params);

          this.logger.info(
            `Load event history for aggregate '${this.aggregateName}' with aggregateId '${aggregateId}'`
          );

          this.logger.info(
            `Options: payload=${payload}, startTime=${startTime}, finishTime'=${finishTime}, limit=${limit}`
          );

          const eventFilter = this.cleanFilter({
            // eventTypes: ["news/created"] // Or null to load ALL event types
            aggregateIds: [aggregateId], // Or null to load ALL aggregate ids
            startTime, // Or null to load events from beginning of time
            finishTime, // Or null to load events to current time
            limit,
          });

          const result = await this.loadHistory(eventFilter, payload);

          const hrend = process.hrtime(hrstart);
          this.logger.info(
            `Materialized ${this.aggregateName} with aggregateId ${aggregateId} %ds %dms`,
            hrend[0],
            hrend[1] / 1000000
          );
          return result;
        },
      },

      replay: {
        params: {
          viewModels: { type: "array" },
          broadcast: { type: "boolean", optional: true },
        },
        async handler(ctx) {
          const hrstart = process.hrtime();

          const events = this.broker.registry.getEventList({
            onlyLocal: false,
            onlyAvailable: true,
            skipInternal: true,
            withEndpoints: false,
          });

          const {
            viewModels,
            startTime,
            finishTime,
            broadcast = false,
          } = ctx.params;

          const eventTypes = [
            ...new Set(
              events
                .filter((e) => viewModels.includes(e.group))
                .map((e) => e.name)
            ),
          ];

          this.logger.info("Replay events", viewModels);

          this.logger.info(
            `Options: startTime=${startTime}, finishTime=${finishTime}, broadcast events=${broadcast}`
          );

          const eventFilter = this.cleanFilter({
            eventTypes, // Or null to load ALL event types
            startTime, // Or null to load events from beginning of time
            finishTime, // Or null to load events to current time
          });

          let eventCount = 0;

          const eventHandler = async (event) => {
            this.logger.debug(event.type, event, viewModels);
            if (broadcast) {
              await this.broker.broadcast(event.type, event, viewModels);
            } else {
              await this.broker.emit(
                event.type,
                { ...event, sequence: eventCount },
                viewModels
              );
            }
            await this.delay(10);
            eventCount++;
          };

          await Promise.all(
            viewModels.map((viewModel) => {
              return this.broker.call(`${viewModel}.dispose`).catch((e) => {
                if (e.code !== 404) {
                  this.logger.error(e);
                  throw new MoleculerServerError(e.message);
                }
              });
            })
          );

          await (async () => {
            let { events } = await this.eventstoreAdapter.loadEvents(
              eventFilter
            );
            for (const event of events) {
              await eventHandler(event);
            }
          })();

          const hrend = process.hrtime(hrstart);
          this.logger.info(
            `Replayed event types (${eventTypes.join(
              ", "
            )}), total events emitted ${eventCount} (broadcast mode → ${broadcast}) ${
              hrend[0]
            }s ${hrend[1] / 1000000}ms`
          );
          return { eventFilter, eventCount };
        },
      },
    },
    methods: {
      async delay(ms = 10) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      async loadHistory(eventFilter, withPayload) {
        let eventCount = 0;
        const state = [];

        const eventHandler = async (event) => {
          state.push({
            version: event.aggregateVersion,
            timestamp: event.timestamp,
            datetime: new Date(event.timestamp).toISOString(),
            eventType: event.type,
            ...{ ...(withPayload && { payload: event.payload }) },
          });
          eventCount++;
        };

        await (async () => {
          let { events } = await this.eventstoreAdapter.loadEvents(eventFilter);
          for (const event of events) {
            await eventHandler(event);
          }
        })();

        this.logger.info("Loaded %d", eventCount);
        return state;
      },

      async materializeReadModelState(eventFilter) {
        let eventCount = 0;
        const { projection } = this.aggregate;
        let state = projection.Init();

        const eventHandler = (event) => {
          state = projection[event.type](state, event);
          eventCount++;
        };

        await (async () => {
          let { events } = await this.eventstoreAdapter.loadEvents(eventFilter);
          for (const event of events) {
            await eventHandler(event);
          }
        })();

        this.logger.info("Loaded %d events", eventCount);

        return state;
      },

      cleanFilter(filter) {
        let ret = Object.assign({}, filter);
        Object.keys(ret).forEach((key) =>
          ret[key] === undefined ? delete ret[key] : {}
        );
        return ret;
      },
    },

    created() {
      if (!this.schema.eventstoreAdapter) {
        this.logger.info(
          "No eventstoreAdapter defined, use default memory eventstoreAdapter"
        );
        this.eventstoreAdapter = createEsStorage({ databaseFile: ":memory:" });
      } else {
        this.eventstoreAdapter = this.schema.eventstoreAdapter;
      }

      if (this.schema.aggregateName) {
        this.aggregateName = this.schema.aggregateName;
      } else {
        this.aggregateName = this.name;
      }

      const publishEvent = (service) => async (event) => {
        await service.eventstoreAdapter.saveEvent(event);
        await service.broker.broadcast(event.type, event);
      };

      if (this.settings.aggregate) {
        this.aggregate = this.settings.aggregate;
        delete this.settings.aggregate;
        this.commandHandler = createCommandHandler({
          eventstoreAdapter: this.eventstoreAdapter,
          onCommandExecuted: publishEvent(this),
          aggregates: [this.aggregate],
          // snapshotAdapter
        });
        this.metadata.aggregate = true;
        this.metadata.commands = Object.keys(this.aggregate.commands).map(
          (name) => name
        );
        this.metadata.projection = Object.keys(this.aggregate.projection).map(
          (name) => name
        );
        this.metadata.events = Object.keys(this.aggregate.events).map(
          (name) => this.aggregate.events[name]
        );
      }
    },
  };
};
