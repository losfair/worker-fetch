/**
 * Index.js
 *
 * a request API compatible with window.fetch
 *
 * All spec algorithm step numbers are based on https://fetch.spec.whatwg.org/commit-snapshots/ae716822cb3a61843226cd090eefc6589446c1d2/.
 */

import zlib from 'zlib';
import Stream, {PassThrough, pipeline as pump} from 'stream';
import dataUriToBuffer from 'data-uri-to-buffer';

import {writeToStream} from './body.js';
import Response from './response.js';
import Headers, {fromRawHeaders} from './headers.js';
import Request, {getNodeRequestOptions} from './request.js';
import {FetchError} from './errors/fetch-error.js';
import {AbortError} from './errors/abort-error.js';
import {isRedirect} from './utils/is-redirect.js';

export {Headers, Request, Response, FetchError, AbortError, isRedirect};

const supportedSchemas = new Set(['data:', 'http:', 'https:']);

function collectRequestHeaders(rawHeaders) {
	let result = {};
	for(let [k, v] of rawHeaders) {
		if(!result[k]) result[k] = [];
		result[k].push(v);
	}
	return result;
}

/**
 * Fetch function
 *
 * @param   {string | URL | import('./request').default} url - Absolute url or Request instance
 * @param   {*} [options_] - Fetch options
 * @return  {Promise<import('./response').default>}
 */
export async function fetch(url, options_) {
	const request = new Request(url, options_);
	const requestBody = await request.arrayBuffer();

	return await new Promise((resolve, reject) => {
		// Build request object
		const protocol = new URL(request.url).protocol;
		
		if (!supportedSchemas.has(protocol)) {
			throw new TypeError(`node-fetch cannot load ${url}. URL scheme "${protocol.replace(/:$/, '')}" is not supported.`);
		}

		if (protocol === 'data:') {
			const data = dataUriToBuffer(request.url);
			const response = new Response(data, {headers: {'Content-Type': data.typeFull}});
			resolve(response);
			return;
		}

		// Wrap http.request into fetch
		const {signal} = request;
		let response = null;

		const abort = () => {
			const error = new AbortError('The operation was aborted.');
			reject(error);
			if (request.body && request.body instanceof Stream.Readable) {
				request.body.destroy(error);
			}

			if (!response || !response.body) {
				return;
			}

			response.body.emit('error', error);
		};

		if (signal && signal.aborted) {
			abort();
			return;
		}

		const abortAndFinalize = () => {
			abort();
			finalize();
		};

		if (signal) {
			signal.addEventListener('abort', abortAndFinalize);
		}

		const finalize = () => {
			if (signal) {
				signal.removeEventListener('abort', abortAndFinalize);
			}
		};

		// Send request
		let req = {
			Async: {
				Fetch: {
					method: request.method,
					url: request.url,
					headers: collectRequestHeaders(request.headers),
				}
			}
		};
		_callService(req, [requestBody], maybeResponse => {
			if(!maybeResponse.Ok) {
				reject(new FetchError('io error', 'system', maybeResponse.Err));
				finalize();
				return;
			}

			if(!maybeResponse.Ok.Ok) {
				reject(new FetchError(`request to ${request.url} failed, reason: ${maybeResponse.Ok.Err}`, 'system', maybeResponse.Ok.Err));
				finalize();
				return;
			}
			const response_ = maybeResponse.Ok.Ok;
			
			const headers = fromRawHeaders(response_.headers);

			// Redirect handled by runtime

			// Prepare response
			if (signal) {
				signal.removeEventListener('abort', abortAndFinalize);
			}

			// Decode body
			let body;
			if("Text" in response_.body) {
				body = response_.body.Text;
			} else {
				body = new Uint8Array(response_.body.Binary).buffer;
			}

			const responseOptions = {
				url: request.url,
				status: response_.status,
				statusText: "No status", // TODO
				headers,
				size: request.size,
				counter: request.counter,
				highWaterMark: request.highWaterMark
			};

			// Compression handled by runtime

			response = new Response(body, responseOptions);
			resolve(response);
		});
	});
}
