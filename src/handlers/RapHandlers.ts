import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import { parseServiceBinding } from 'abap-adt-api';
import { XMLParser } from 'fast-xml-parser';

export class RapHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'rap_binding_details',
        annotations: { readOnlyHint: true },
        description:
          'Get the service binding details for a published OData service binding. ' +
          'Returns the service URL, entity sets, navigation properties, and annotation URL. ' +
          'Use after rap_publish_binding or to inspect an existing published binding. ' +
          'For bindings with multiple services, use index to select which service (default: 0).',
        inputSchema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Service binding name, e.g. /DSN/UI_MYSERVICE_O4' },
            index:   { type: 'number', description: 'Service index (default: 0 for the first service)' }
          },
          required: ['name']
        }
      },
      {
        name: 'rap_publish_binding',
        description:
          'Publish or unpublish an OData service binding on the SAP system. ' +
          'Publishing generates the service URL and makes it accessible for consumption. ' +
          'Use after creating or updating a SRVB (service binding) object. ' +
          'Returns the SAP response message indicating success or any issues.',
        inputSchema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Service binding name (e.g. /DSN/UI_MYSERVICE_O4)' },
            version: { type: 'string', description: 'Binding version number (e.g. 0001)' },
            action:  { type: 'string', description: 'publish or unpublish', enum: ['publish', 'unpublish'] }
          },
          required: ['name', 'version', 'action']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'rap_binding_details': return this.handleBindingDetails(args);
      case 'rap_publish_binding': return this.handlePublishBinding(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  // The abap-adt-api library's bindingDetails()/extractBindingLinks() only understand OData V2
  // bindings: extractBindingLinks() filters binding.links for rel === ".../categories/odatav2"
  // and, finding nothing for a V4 binding, returns [] — then bindingDetails() destructures
  // queries[0] and crashes with "Cannot destructure property 'query' of 'queries[index]' as it
  // is undefined". Found live testing rap_bo_scaffold's OData V4 output. Fixed by handling the
  // V4 "serviceGroup" response ourselves and only delegating to the library for real V2 bindings.
  private parseODataV4ServiceGroup(xml: string): any {
    const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_' });
    const doc = parser.parse(xml || '');
    const group = doc?.serviceGroup;
    if (!group) return { services: [] };
    const arr = (v: any) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const services = arr(group.services).map((svc: any) => {
      const info = svc.serviceInformation;
      const collections = arr(info?.collection).map((c: any) => c['@_name']).filter(Boolean);
      return {
        serviceId: svc['@_serviceId'],
        serviceVersion: svc['@_serviceVersion'],
        serviceUrl: svc['@_serviceUrl'],
        annotationUrl: svc['@_annotationUrl'] || undefined,
        entitySets: collections,
      };
    });
    return { serviceUrlPrefix: group['@_serviceUrlPrefix'], services };
  }

  private async handleBindingDetails(args: any): Promise<any> {
    const encoded = args.name.replace(/\//g, '%2f').toLowerCase();
    const bindingUrl = `/sap/bc/adt/businessservices/bindings/${encoded}`;
    try {
      const h = (this.adtclient as any).h;
      const response = await this.withSession(() =>
        h.request(bindingUrl, { headers: { Accept: 'application/*' } })
      ) as any;
      const binding = parseServiceBinding(response.body || '');
      const idx = args.index ?? 0;
      const service = binding.services?.[idx];
      if (!service) this.fail(`rap_binding_details(${args.name}): no service at index ${idx} in this binding (it has ${binding.services?.length ?? 0}).`);

      const v4Link = binding.links.find((l: any) => l.rel === 'http://www.sap.com/categories/odatav4');
      const v2Link = binding.links.find((l: any) => l.rel === 'http://www.sap.com/categories/odatav2');
      const baseUrl = String(h.baseURL || '').replace(/\/$/, '');

      if (v4Link) {
        const qs = { servicename: service.name, serviceversion: service.version, srvdname: service.serviceDefinition.name };
        const detailResponse = await this.withSession(() =>
          h.request(v4Link.href, { qs, headers: { Accept: 'application/*' } })
        ) as any;
        const parsed = this.parseODataV4ServiceGroup(detailResponse.body || '');
        parsed.services = (parsed.services || []).map((s: any) => ({
          ...s,
          serviceUrlFull: s.serviceUrl ? `${baseUrl}${s.serviceUrl}` : undefined,
        }));
        return this.success({ name: args.name, published: binding.published, odataVersion: 'V4', ...parsed });
      }

      if (v2Link) {
        const details = await this.withSession(() =>
          this.adtclient.bindingDetails(binding, idx)
        );
        return this.success({ name: args.name, published: binding.published, odataVersion: 'V2', ...details });
      }

      this.fail(`rap_binding_details(${args.name}): binding has neither an OData V2 nor V4 link -- is it published? Call rap_publish_binding first.`);
    } catch (error: any) {
      this.fail(formatError(`rap_binding_details(${args.name})`, error));
    }
  }

  private async handlePublishBinding(args: any): Promise<any> {
    const { name, version, action } = args;
    try {
      await this.notify(`${action === 'publish' ? 'Publishing' : 'Unpublishing'} service binding ${name} v${version}…`);

      const result = action === 'publish'
        ? await this.withSession(() => this.adtclient.publishServiceBinding(name, version))
        : await this.withSession(() => this.adtclient.unPublishServiceBinding(name, version));

      return this.success({
        name,
        version,
        action,
        severity: result.severity,
        message: result.shortText,
        detail: result.longText || undefined
      });
    } catch (error: any) {
      this.fail(formatError(`rap_publish_binding(${name})`, error));
    }
  }
}
