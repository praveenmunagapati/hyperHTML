import majinbuu from 'https://unpkg.com/majinbuu@latest/esm/main.js';

import {
  CONNECTED, DISCONNECTED,
  COMMENT_NODE, DOCUMENT_FRAGMENT_NODE, ELEMENT_NODE, TEXT_NODE,
  OWNER_SVG_ELEMENT,
  IS_NON_DIMENSIONAL,
  SHOULD_USE_TEXT_CONTENT,
  UID, UIDC
} from '../shared/constants.js';

import Aura from '../classes/Aura.js';
import Component from '../classes/Component.js';
import Path from './Path.js';
import Transformer from './Transformer.js';
import {text} from '../shared/easy-dom.js';
import {Event, WeakSet, isArray, trim} from '../shared/poorlyfills.js';
import {createFragment, slice} from '../shared/utils.js';

// if you want to use Promises as interpolation value
// be sure your browser supports them or provide a polyfill
// before including/importing hyperHTML
const Promise = global.Promise;

// primitives are useful interpolations values
// and will result in very fast operations
// for either attributes or nodes content updates
const NUMBER = 'number';
const OBJECT = 'object';
const STRING = 'string';

// hyper.Component have a connected/disconnected
// mechanism provided by MutationObserver
// This weak set is used to recognize components
// as DOM node that needs to trigger connected/disconnected events
const components = new WeakSet;

// a basic dictionary used to filter already cached attributes
// while looking for special hyperHTML values.
function Cache() {}
Cache.prototype = Object.create(null);

// returns an intent to explicitly inject content as html
const asHTML = html => ({html});

// updates are created once per context upgrade
// within the main render function (../hyper/render.js)
// These are an Array of callbacks to invoke passing
// each interpolation value.
// Updates can be related to any kind of content,
// attributes, or special text-only cases such <style>
// elements or <textarea>
const create = (root, paths) => {
  const updates = [];
  const length = paths.length;
  for (let i = 0; i < length; i++) {
    const info = paths[i];
    const node = Path.find(root, info.path);
    switch (info.type) {
      case 'any':
        updates.push(setAnyContent(node, []));
        break;
      case 'attr':
        updates.push(setAttribute(node, info.name, info.node));
        break;
      case 'text':
        updates.push(setTextContent(node));
        break;
    }
  }
  return updates;
};

// when hyper.Component related DOM nodes
// are appended or removed from the live tree
// these might listen to connected/disconnected events
// This utility is in charge of finding all components
// involved in the DOM update/change and dispatch
// related information to them
const dispatchAll = (nodes, type) => {
  const event = new Event(type);
  const length = nodes.length;
  for (let i = 0; i < length; i++) {
    let node = nodes[i];
    if (node.nodeType === ELEMENT_NODE) {
      dispatchTarget(node, event);
    }
  }
};

// the way it's done is via the components weak set
// and recursively looking for nested components too
const dispatchTarget = (node, event) => {
  if (components.has(node)) {
    node.dispatchEvent(event);
  } else {
    const children = node.children;
    const length = children.length;
    for (let i = 0; i < length; i++) {
      dispatchTarget(children[i], event);
    }
  }
}

// finding all paths is a one-off operation performed
// when a new template literal is used.
// The goal is to map all target nodes that will be
// used to update content/attributes every time
// the same template literal is used to create content.
// The result is a list of paths related to the template
// with all the necessary info to create updates as
// list of callbacks that target directly affected nodes.
const find = (node, paths, parts) => {
  const childNodes = node.childNodes;
  const length = childNodes.length;
  for (let i = 0; i < length; i++) {
    let child = childNodes[i];
    switch (child.nodeType) {
      case ELEMENT_NODE:
        findAttributes(child, paths, parts);
        find(child, paths, parts);
        break;
      case COMMENT_NODE:
        if (child.textContent === UID) {
          parts.shift();
          paths.push(
            // basicHTML or other non standard engines
            // might end up having comments in nodes
            // where they shouldn't, hence this check.
            SHOULD_USE_TEXT_CONTENT.test(node.nodeName) ?
              Path.create('text', node) :
              Path.create('any', child)
          );
        }
        break;
      case TEXT_NODE:
        // the following ignore is actually covered by browsers
        // only basicHTML ends up on previous COMMENT_NODE case
        // instead of TEXT_NODE because it knows nothing about
        // special style or textarea behavior
        /* istanbul ignore if */
        if (
          SHOULD_USE_TEXT_CONTENT.test(node.nodeName) &&
          trim.call(child.textContent) === UIDC
        ) {
          parts.shift();
          paths.push(Path.create('text', node));
        }
        break;
    }
  }
};

// attributes are searched via unique hyperHTML id value.
// Despite HTML being case insensitive, hyperHTML is able
// to recognize attributes by name in a caseSensitive way.
// This plays well with Custom Elements definitions
// and also with XML-like environments, without trusting
// the resulting DOM but the template literal as the source of truth.
// IE/Edge has a funny bug with attributes and these might be duplicated.
// This is why there is a cache in charge of being sure no duplicated
// attributes are ever considered in future updates.
const findAttributes = (node, paths, parts) => {
  const cache = new Cache;
  const attributes = node.attributes;
  const array = slice.call(attributes);
  const remove = [];
  const length = array.length;
  for (let i = 0; i < length; i++) {
    const attribute = array[i];
    if (attribute.value === UID) {
      const name = attribute.name;
      // the following ignore is covered by IE
      // and the IE9 double viewBox test
      /* istanbul ignore else */
      if (!(name in cache)) {
        const realName = parts.shift().replace(/^(?:|[\S\s]*?\s)(\S+?)=['"]?$/, '$1');
        cache[name] = attributes[realName] ||
                      // the following ignore is covered by browsers
                      // while basicHTML is already case-sensitive
                      /* istanbul ignore next */
                      attributes[realName.toLowerCase()];
        paths.push(Path.create('attr', cache[name], realName));
      }
      remove.push(attribute);
    }
  }
  const len = remove.length;
  for (let i = 0; i < remove.length; i++) {
    node.removeAttributeNode(remove[i]);
  }
};

// when a Promise is used as interpolation value
// its result must be parsed once resolved.
// This callback is in charge of understanding what to do
// with a returned value once the promise is resolved.
const invokeAtDistance = (value, callback) => {
  callback(value.placeholder);
  if ('text' in value) {
    Promise.resolve(value.text).then(String).then(callback);
  } else if ('any' in value) {
    Promise.resolve(value.any).then(callback);
  } else if ('html' in value) {
    Promise.resolve(value.html).then(asHTML).then(callback);
  } else {
    Promise.resolve(Transformer.invoke(value, callback)).then(callback);
  }
};

// quick and dirty ways to check a value type without abusing instanceof
const isNode_ish = value => 'ELEMENT_NODE' in value;
const isPromise_ish = value => value != null && 'then' in value;

// special attributes are usually available through their owner class
// 'value' in input
// 'src' in img
// and so on. These attributes don't act properly via get/setAttribute
// so in these case their value is set, or retrieved, right away
// input.value = ...
// img.src = ...
const isSpecial = (node, name) => !(OWNER_SVG_ELEMENT in node) && name in node;

// whenever a list of nodes/components is updated
// there might be updates or not.
// If the new list has different length, there's surely
// some DOM operation to perform.
// Otherwise operations should be performed **only**
// if the content od the two lists is different from before.
// Majinbuu is the project in charge of computing these differences.
// It uses the Levenshtein distance algorithm to produce the least amount
// of splice operations an Array needs to become like another Array.
const optimist = (aura, value) => {
  let length = aura.length;
  if (value.length !== length) {
    // TODO: there's room for improvements for common cases
    // where a single node has been appended or prepended
    // and the whole Levenshtein distance computation
    // would be overkill
    majinbuu(aura, value, Aura.MAX_LIST_SIZE);
  } else {
    for (let i = 0; i < length--; i++) {
      if (aura[length] !== value[length] || aura[i] !== value[i]) {
        majinbuu(aura, value, Aura.MAX_LIST_SIZE);
        return;
      }
    }
  }
};

// in a hyper(node)`<div>${content}</div>` case
// everything could happen:
//  * it's a JS primitive, stored as text
//  * it's null or undefined, the node should be cleaned
//  * it's a component, update the content by rendering it
//  * it's a promise, update the content once resolved
//  * it's an explicit intent, perform the desired operation
//  * it's an Array, resolve all values if Promises and/or
//    update the node with the resulting list of content
const setAnyContent = (node, childNodes) => {
  const aura = new Aura(node, childNodes);
  let oldValue;
  const anyContent = value => {
    switch (typeof value) {
      case STRING:
      case NUMBER:
      case 'boolean':
        let length = childNodes.length;
        if (
          length === 1 &&
          childNodes[0].nodeType === TEXT_NODE
        ) {
          if (oldValue !== value) {
            oldValue = value;
            childNodes[0].textContent = value;
          }
        } else {
          oldValue = value;
          if (length) {
            aura.splice(0, length, text(node, value));
          } else {
            node.parentNode.insertBefore(
              (childNodes[0] = text(node, value)),
              node
            );
          }
        }
        break;
      case OBJECT:
      case 'undefined':
        if (value == null) {
          oldValue = value;
          anyContent('');
          break;
        }
      default:
        oldValue = value;
        if (isArray(value)) {
          if (value.length === 0) {
            aura.splice(0);
          } else {
            switch (typeof value[0]) {
              case STRING:
              case NUMBER:
              case 'boolean':
                anyContent({html: value});
                break;
              case OBJECT:
                if (isArray(value[0])) {
                  value = value.concat.apply([], value);
                }
                if (isPromise_ish(value[0])) {
                  Promise.all(value).then(anyContent);
                  break;
                }
              default:
                optimist(aura, value);
                break;
            }
          }
        } else if (value instanceof Component) {
          optimist(aura, [value]);
        } else if (isNode_ish(value)) {
          optimist(
            aura,
            value.nodeType === DOCUMENT_FRAGMENT_NODE ?
              slice.call(value.childNodes) :
              [value]
          );
        } else if (isPromise_ish(value)) {
          value.then(anyContent);
        } else if ('placeholder' in value) {
          invokeAtDistance(value, anyContent);
        } else if ('text' in value) {
          anyContent(String(value.text));
        } else if ('any' in value) {
          anyContent(value.any);
        } else if ('html' in value) {
          aura.splice(0);
          const fragment = createFragment(node, [].concat(value.html).join(''));
          childNodes.push.apply(childNodes, fragment.childNodes);
          node.parentNode.insertBefore(fragment, node);
        } else if ('length' in value) {
          anyContent(slice.call(value));
        } else {
          anyContent(Transformer.invoke(value, anyContent));
        }
        break;
    }
  };
  return anyContent;
};

// there are four kind of attributes, and related behavior:
//  * events, with a name starting with `on`, to add/remove event listeners
//  * special, with a name present in their inherited prototype, accessed directly
//  * regular, accessed through get/setAttribute standard DOM methods
//  * style, the only regular attribute that also accepts an object as value
//    so that you can style=${{width: 120}}. In this case, the behavior has been
//    fully inspired by Preact library and its simplicity.
const setAttribute = (node, name, original) => {
  const isStyle = name === 'style';
  const isData = !isStyle && name === 'data';
  let oldValue;
  if (!isStyle && !isData && /^on/.test(name)) {
    let type = name.slice(2);
    if (type === CONNECTED || type === DISCONNECTED) {
      components.add(node);
    }
    else if (name.toLowerCase() in node) {
      type = type.toLowerCase();
    }
    return newValue => {
      if (oldValue !== newValue) {
        if (oldValue) node.removeEventListener(type, oldValue, false);
        oldValue = newValue;
        if (newValue) node.addEventListener(type, newValue, false);
      }
    };
  } else if(isData || (!isStyle && isSpecial(node, name))) {
    return newValue => {
      if (oldValue !== newValue) {
        oldValue = newValue;
        if (node[name] !== newValue) {
          node[name] = newValue;
          if (newValue == null) {
            node.removeAttribute(name);
          }
        }
      }
    };
  } else if (isStyle) {
    let oldType;
    return newValue => {
      switch (typeof newValue) {
        case OBJECT:
          if (newValue) {
            const style = node.style;
            if (oldType === OBJECT) {
              for (const key in oldValue) {
                if (!(key in newValue)) {
                  style[key] = '';
                }
              }
            } else {
              style.cssText = '';
            }
            for (const key in newValue) {
              const value = newValue[key];
              style[key] =  typeof value === NUMBER &&
                            !IS_NON_DIMENSIONAL.test(key) ?
                              (value + 'px') : value;
            }
            oldType = OBJECT;
            oldValue = newValue;
            break;
          }
        default:
          if (oldValue != newValue) {
            oldType = STRING;
            oldValue = newValue;
            node.style.cssText = newValue || '';
          }
          break;
      }
    };
  } else {
    let noOwner = true;
    const attribute = original.cloneNode(true);
    return newValue => {
      if (oldValue !== newValue) {
        oldValue = newValue;
        if (attribute.value !== newValue) {
          if (newValue == null) {
            if (!noOwner) {
              noOwner = true;
              node.removeAttributeNode(attribute);
            }
          } else {
            attribute.value = newValue;
            if (noOwner) {
              noOwner = false;
              node.setAttributeNode(attribute);
            }
          }
        }
      }
    };
  }
};

// style or textareas don't accept HTML as content
// it's pointless to transform or analyze anything
// different from text there but it's worth checking
// for possible defined intents.
const setTextContent = node => {
  let oldValue;
  const textContent = value => {
    if (oldValue !== value) {
      oldValue = value;
      if (typeof value === 'object' && value) {
        if (isPromise_ish(value)) {
          value.then(textContent);
        } else if ('placeholder' in value) {
          invokeAtDistance(value, textContent);
        } else if ('text' in value) {
          textContent(String(value.text));
        } else if ('any' in value) {
          textContent(value.any);
        } else if ('html' in value) {
          textContent([].concat(value.html).join(''));
        } else if ('length' in value) {
          textContent(slice.call(value).join(''));
        } else {
          textContent(Transformer.invoke(value, textContent));
        }
      } else {
        node.textContent = value == null ? '' : value;
      }
    }
  };
  return textContent;
};

// hyper.Components might need connected/disconnected notifications
// The MutationObserver is the best way to implement that
// but there is a fallback to deprecated DOMNodeInserted/Removed
// so that even older browsers/engines can help components life-cycle
try {
  (new MutationObserver(records => {
    const length = records.length;
    for (let i = 0; i < length; i++) {
      let record = records[i];
      dispatchAll(record.removedNodes, DISCONNECTED);
      dispatchAll(record.addedNodes, CONNECTED);
    }
  })).observe(document, {subtree: true, childList: true});
} catch(o_O) {
  document.addEventListener('DOMNodeRemoved', event => {
    dispatchAll([event.target], DISCONNECTED);
  }, false);
  document.addEventListener('DOMNodeInserted', event => {
    dispatchAll([event.target], CONNECTED);
  }, false);
}

export default {create, find};
